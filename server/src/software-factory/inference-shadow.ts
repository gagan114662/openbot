import type { RunAgentInput } from "@ag-ui/client";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import type { ShadowEvaluator } from "./shadow-evaluator";

type ShadowMessage = { role: string; content: string };

export async function invokeCodexSubscriptionShadow(
  messages: ShadowMessage[],
  options: {
    model: string;
    cwd: string;
    signal: AbortSignal;
  },
) {
  const directory = await mkdtemp(join(tmpdir(), "openbot-shadow-"));
  const outputPath = join(directory, "answer.txt");
  const prompt = [
    "Act as a shadow evaluator. Answer the supplied conversation independently.",
    "Do not edit files, run tools, or mention this evaluation wrapper.",
    JSON.stringify(messages),
  ].join("\n");
  const child = spawn(
    [
      "codex",
      "exec",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--model",
      options.model,
      "--output-last-message",
      outputPath,
      prompt,
    ],
    { cwd: options.cwd, stdout: "ignore", stderr: "pipe" },
  );
  const abort = () => child.kill("SIGTERM");
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    if (options.signal.aborted)
      throw new Error("Codex subscription shadow timed out.");
    if (exitCode !== 0)
      throw new Error(
        `Codex subscription shadow failed (${exitCode}): ${stderr.slice(-2_000)}`,
      );
    const output = (await readFile(outputPath, "utf8")).trim();
    if (!output) throw new Error("Codex subscription shadow returned no text.");
    return output;
  } finally {
    options.signal.removeEventListener("abort", abort);
    await rm(directory, { recursive: true, force: true });
  }
}

export function createInferenceShadowRecorder(options: {
  evaluator: Pick<ShadowEvaluator, "shouldEvaluate" | "record">;
  primaryModel: string;
  shadowModel: string;
  rateBasisPoints: number;
  resolveApiKey?: () => Promise<string | null>;
  endpoint?: string;
  fetch?: typeof fetch;
  invokeShadow?: (
    messages: ShadowMessage[],
    signal: AbortSignal,
  ) => Promise<string>;
  timeoutMs?: number;
}) {
  return async (input: { run: RunAgentInput; primaryOutput: string }) => {
    if (
      !options.evaluator.shouldEvaluate(
        input.run.runId,
        options.rateBasisPoints,
      )
    )
      return;
    const messages = input.run.messages.flatMap((message) =>
      typeof message.content === "string"
        ? [{ role: message.role, content: message.content }]
        : [],
    );
    const signal = AbortSignal.timeout(options.timeoutMs ?? 60_000);
    const started = performance.now();
    let shadowOutput: string;
    if (options.invokeShadow) {
      shadowOutput = await options.invokeShadow(messages, signal);
    } else {
      const key = await options.resolveApiKey?.();
      if (!key) throw new Error("Shadow inference has no model credential.");
      if (!options.endpoint)
        throw new Error("Shadow inference has no model endpoint.");
      const response = await (options.fetch ?? fetch)(options.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ model: options.shadowModel, messages }),
        signal,
      });
      if (!response.ok)
        throw new Error(`Shadow model answered ${response.status}.`);
      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string")
        throw new Error("Shadow model returned no text.");
      shadowOutput = content;
    }
    await options.evaluator.record({
      requestKey: input.run.runId,
      primaryModel: options.primaryModel,
      shadowModel: options.shadowModel,
      primaryOutput: input.primaryOutput,
      shadowOutput,
      shadowLatencyMs: performance.now() - started,
    });
  };
}
