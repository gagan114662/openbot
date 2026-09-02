import { createHash } from "node:crypto";

type Message = {
  id?: string;
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolCalls?: Array<{ id?: string }>;
};

const canonical = (value: unknown) => JSON.stringify(value) ?? "";
const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  return canonical(content);
}

function retainedTail<T extends Message>(messages: T[], minimum: number): T[] {
  let start = Math.max(0, messages.length - minimum);
  // A tool result is meaningful only with the assistant call that created it. Move the boundary
  // to the matching assistant message, retaining the whole call/result group atomically.
  while (start > 0 && messages[start]?.role === "tool") {
    const callId = messages[start]?.toolCallId;
    let assistant = start - 1;
    while (assistant >= 0 && messages[assistant]?.role === "tool")
      assistant -= 1;
    const calls = messages[assistant]?.toolCalls ?? [];
    if (
      messages[assistant]?.role !== "assistant" ||
      (callId && !calls.some((call) => call.id === callId))
    ) {
      break;
    }
    start = assistant;
  }
  return messages.slice(start);
}

export type CompactionResult<T extends Message> = {
  messages: T[];
  compacted: boolean;
  capsuleChecksum: string;
  omittedMessages: number;
};

/**
 * Deterministically compact old turns while preserving and re-asserting every system invariant.
 * The checksum binds the exact omitted messages, retained tail and invariant set; a downstream
 * stage can reject a stale capsule instead of silently continuing with a different conversation.
 */
export function compactMessages<T extends Message>(
  messages: readonly T[],
  options: { thresholdCharacters?: number; retainRecent?: number } = {},
): CompactionResult<T> {
  const threshold = options.thresholdCharacters ?? 48_000;
  const retainRecent = Math.max(1, options.retainRecent ?? 12);
  const totalCharacters = messages.reduce(
    (sum, message) => sum + contentText(message.content).length,
    0,
  );
  const systems = messages.filter((message) => message.role === "system");
  const conversational = messages.filter(
    (message) => message.role !== "system",
  );
  const tail = retainedTail(conversational, retainRecent);
  const omitted = conversational.slice(0, conversational.length - tail.length);
  const capsule = {
    version: 1,
    invariantHash: hash(systems),
    omittedHash: hash(omitted),
    retainedHash: hash(tail),
  };
  const capsuleChecksum = hash(capsule);
  if (totalCharacters <= threshold || omitted.length === 0) {
    return {
      messages: [...messages],
      compacted: false,
      capsuleChecksum,
      omittedMessages: 0,
    };
  }

  const summary = {
    id: `context-compaction:${capsuleChecksum}`,
    role: "system",
    content: [
      "[OpenBot context compaction — deterministic, not an assistant-authored claim]",
      `${omitted.length} older conversation messages were compacted after the context threshold.`,
      `Omitted-message hash: ${capsule.omittedHash}`,
      `Retained-tail hash: ${capsule.retainedHash}`,
      `Invariant hash: ${capsule.invariantHash}`,
      `Context-capsule checksum: ${capsuleChecksum}`,
      "All system instructions and approved tenant invariants are re-asserted immediately before this capsule.",
      "Do not infer facts from omitted turns. Ask for missing detail when the retained tail is insufficient.",
    ].join("\n"),
  } as T;

  const compacted = [...systems, summary, ...tail];
  const embedded = contentText(summary.content).includes(capsuleChecksum);
  if (
    !embedded ||
    hash({
      version: 1,
      invariantHash: hash(systems),
      omittedHash: hash(omitted),
      retainedHash: hash(tail),
    }) !== capsuleChecksum
  ) {
    throw new Error("context compaction checksum could not be verified");
  }
  return {
    messages: compacted,
    compacted: true,
    capsuleChecksum,
    omittedMessages: omitted.length,
  };
}
