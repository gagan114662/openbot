import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { AbstractAgent, HttpAgent } from "@ag-ui/client";
import type { BuiltInAgentConfiguration } from "@copilotkit/runtime/v2";
import {
  BuiltInAgent,
  CopilotKitIntelligence,
  CopilotRuntime,
} from "@copilotkit/runtime/v2";
import { createCopilotHonoHandler } from "@copilotkit/runtime/v2/hono";
import type { Observable } from "rxjs";
import {
  catchError,
  defer,
  from,
  lastValueFrom,
  map,
  mergeMap,
  switchMap,
  TimeoutError,
  takeUntil,
  tap,
  throwError,
  timer,
  toArray,
} from "rxjs";
import { z } from "zod";
import {
  COMPUTER_GUIDANCE,
  EXECUTION_GUIDANCE,
  PROVENANCE_GUIDANCE,
} from "../../shared/bot-prompt";
import type {
  ScoredEpisode,
  VerifiableEpisode,
} from "../../shared/verifiable-reward";
import { compactMessages } from "./agents/context-compaction";
import type { AgentActor } from "./agents/profile-types";
import { verifyRuntimeEpisode } from "./analytics/runtime-verification";
import type { AgentFetch, StallGuard } from "./channels/stall-guard";
import type { DeploymentConfig } from "./config";
import type { SelectableSkill, Selection } from "./plugins/selection";
import {
  latestUserText,
  SELECTION_FLOOR,
  selectTools,
} from "./plugins/selection";
import type { GrantedTool } from "./plugins/tools";
import { grantedToolGuidance } from "./plugins/tools";

/**
 * The CopilotKit runtime, always in Intelligence mode.
 *
 * Package-declared built-in Bots run as CopilotKit `BuiltInAgent` instances. External Bots are
 * reached over AG-UI as `HttpAgent` instances, so anything that speaks the protocol remains a Bot
 * with no framework adapter here: LangGraph, Pydantic-AI, CrewAI, Mastra, ADK, or a hand-written
 * server.
 *
 * There is no SSE branch. Intelligence is a requirement of the product, not a tier: it owns
 * durable threads, memory and learning, and a deployment without it silently forgets every
 * conversation. config.ts refuses to boot without the full contract, so by the time this runs the
 * settings are present and this file has one mode.
 */

/** Resolve the signed-in person for a request. Threads and memory are scoped to whoever this returns. */
export type IdentifyUser = (
  request: Request,
) => Promise<{ id: string; name: string }>;

type RegisteredBuiltInAgent = {
  id: string;
  name: string;
  type: "built_in";
  systemPrompt: string;
};

type RegisteredRemoteAgent = {
  id: string;
  name: string;
  type: "remote_ag_ui";
  endpoint: string;
  standingMessage: StandingRoleMessage;
  /** The key this agent sits behind, resolved from the vault at load time. Never logged. */
  headers?: Record<string, string>;
};

/**
 * A coworker the caller may see but may not run: its profile was deleted while a channel it worked
 * in still exists. It is registered so Intelligence can restore that thread and the person can read
 * what was said; every run is refused here, without contacting the endpoint.
 */
type RegisteredUnavailableAgent = {
  id: string;
  name: string;
  type: "unavailable";
  reason: string;
};

export type RegisteredAgent =
  RegisteredBuiltInAgent | RegisteredRemoteAgent | RegisteredUnavailableAgent;

type AgentRunInput = Parameters<AbstractAgent["run"]>[0];
type AgentMessage = AgentRunInput["messages"][number];
export type StandingRoleMessage = Extract<AgentMessage, { role: "system" }>;

/** The durable part of a coworker: who it is and what its standing job is. */
export type AgentStandingProfile = {
  id: string;
  name: string;
  title: string;
  roleDescription: string;
};

/**
 * The coworker's job, as one system message.
 *
 * It is an ordinary AG-UI system message rather than `forwardedProps` or framework-specific state
 * because the endpoint on the other side may be LangGraph, Mastra, ADK or a hand-written server, and
 * a system message is the only thing all of them already understand. The id is derived from the
 * agent so a run can recognise a copy of it and refuse to send a second.
 */
export function standingRoleMessage(
  profile: AgentStandingProfile,
): StandingRoleMessage {
  return {
    id: `standing-role:${profile.id}`,
    role: "system",
    content: [
      `You are ${profile.name}, ${profile.title}.`,
      profile.roleDescription,
      "This standing role applies in every channel. Treat channel messages as task-specific instructions within it.",
      EXECUTION_GUIDANCE,
      /*
       * Here rather than in the package, because for a remote Bot the standing role is the only
       * instruction there is: `role_description` is one sentence somebody wrote about what it is
       * for, and nothing else reaches it. The compliance Bot that answered a filing question with
       * thresholds and deadlines and no source was a `remote-ag-ui` agent whose entire prompt was
       * "Investigate policies, transaction monitoring, and control evidence."
       */
      PROVENANCE_GUIDANCE,
    ].join("\n\n"),
  };
}

export type RuntimeModel = {
  provider: "openai";
  defaultModel: string;
};

type RuntimeAgentRow = {
  id: string;
  name: string;
  type: "built_in" | "remote_ag_ui";
  configuration: unknown;
  title: string;
  roleDescription: string;
};

export function registeredAgentFromRow(
  row: RuntimeAgentRow,
): RegisteredAgent | null {
  if (!isPlainObject(row.configuration)) {
    return null;
  }
  const configuration = row.configuration;
  if (row.type === "built_in") {
    const systemPrompt = configuration?.systemPrompt;
    const trimmedSystemPrompt =
      typeof systemPrompt === "string" ? systemPrompt.trim() : "";
    return trimmedSystemPrompt.length > 0
      ? {
          id: row.id,
          name: row.name,
          type: "built_in",
          systemPrompt: trimmedSystemPrompt,
        }
      : null;
  }

  const endpoint = configuration?.endpoint;
  return typeof endpoint === "string" && isHttpUrl(endpoint)
    ? {
        id: row.id,
        name: row.name,
        type: "remote_ag_ui",
        endpoint,
        standingMessage: standingRoleMessage(row),
      }
    : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isHttpUrl(value: string) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function builtInAgentConfiguration(
  agent: RegisteredBuiltInAgent,
  model: RuntimeModel,
  apiKey: string | null,
  /**
   * What this Bot may call, resolved for the person asking.
   *
   * Handed to the agent rather than registered by the surface, so a run needs no browser. These are
   * not raw MCP servers on purpose: each one executes through the plugin store, which checks the
   * grant, evaluates the policy and writes the audit row. Passing `mcpServers` here instead would
   * let the agent reach a vendor directly and walk around all three.
   */
  tools: GrantedTool[] = [],
  /**
   * What this Bot should know about the computer, when this deployment has one.
   *
   * Appended to the role rather than replacing it: the package says what the Bot is for, this says
   * what its hands are. Absent leaves the role alone, which is right for a deployment with no
   * computer configured, where the browser routes are not mounted and a Bot promised a browser would
   * be promising something that does not exist.
   */
  computerGuidance?: string,
  /**
   * Vendors this deployment connects to, whether or not this Bot holds any of their tools.
   *
   * A Bot holding nothing was told nothing, so it treated a connected vendor as an ordinary website
   * and browsed to it. See `grantedToolGuidance`.
   */
  connectedVendors: readonly string[] = [],
): BuiltInAgentConfiguration {
  if (!apiKey) {
    return {
      type: "custom",
      // biome-ignore lint/correctness/useYield: this agent must fail when iteration starts.
      factory: async function* () {
        throw new Error(
          `Model credential is not configured for ${agent.name}. Add the package credential or set OPENAI_API_KEY.`,
        );
      },
    };
  }

  return {
    model: `${model.provider}/${model.defaultModel}`,
    /*
     * The package's role, then what this Bot actually holds, then the computer.
     *
     * The grants go BEFORE the computer prose on purpose. That prose is long and emphatic about the
     * browser and mentions connectors nowhere, so a Bot that read it last reached for the browser
     * even when it held a tool for the exact system being asked about.
     */
    prompt: [
      agent.systemPrompt,
      EXECUTION_GUIDANCE,
      /*
       * Unconditional, unlike the two below it.
       *
       * Those describe things a deployment may or may not have. This describes how to answer at all,
       * and a Bot with no tools and no computer needs it most: it has nothing to read, so everything
       * it says comes from its own knowledge, and saying so is the only honest move available.
       */
      PROVENANCE_GUIDANCE,
      ...(grantedToolGuidance(tools, connectedVendors)
        ? [grantedToolGuidance(tools, connectedVendors)]
        : []),
      ...(computerGuidance ? [computerGuidance] : []),
    ].join("\n\n"),
    apiKey,
    /*
     * A run stops after one step unless told otherwise, which for a Bot with tools means it calls
     * one and never speaks: the tool executes, the result arrives, and the run ends before the model
     * can say what it found. The person sees their own question and nothing else.
     *
     * Only set when there are tools, because a Bot with none has nothing to continue for. The cap
     * bounds a model that would otherwise call tools in a circle. Interrupt tools, if any are ever
     * added here, require the default of one and must not be mixed in.
     */
    ...(tools.length > 0 ? { tools, maxSteps: TOOL_STEPS } : {}),
  };
}

/**
 * How many turns of the tool loop one run may take.
 *
 * Enough for a Bot to search, read what came back, search again on a better term, and answer.
 * Beyond that a model is not making progress, and every extra step is somebody's money.
 */
const TOOL_STEPS = 8;

/**
 * Whether the person made evidence gathering part of the requested result.
 *
 * Narrow on explicit research language rather than trying to classify every factual question. The
 * gate below spends a second model attempt when the first ignores its tools, so false positives have
 * a real cost; the phrases here are the cases where an answer from memory cannot satisfy what was
 * asked regardless of whether that memory happens to be right.
 */
export function requiresToolEvidence(text: string): boolean {
  return /\b(?:search|research|look\s*up|verify|fact[- ]?check|browse|current|latest|official sources?|source urls?|cite (?:the )?(?:exact )?(?:sources?|urls?)|as of)\b/i.test(
    text,
  );
}

const EVIDENCE_RETRY_INSTRUCTION = [
  "Your previous draft was rejected because it did not prove the requested retrieved evidence.",
  "Call at least one relevant granted read tool now before answering. Use its returned evidence, cite",
  "only exact final URLs present in the tool result when the person requested URLs. Write each as a literal",
  "https:// URL in the answer, not only as linked label text. Never say you verified or read a source",
  "unless that tool actually returned it. If the tools fail or cannot establish the claim, state the",
  "precise limitation instead of filling the gap from memory.",
].join(" ");

const NO_EVIDENCE_ANSWER =
  "I could not verify this request with the tools available in this run. I have not treated my own memory as current or sourced evidence, so I cannot honestly provide the requested verified answer yet.";

/** Explicit deployment policy. Default false: missing model citations fail closed. */
const EVIDENCE_AUTO_CITE =
  process.env.OPENBOT_EVIDENCE_AUTO_CITE?.trim().toLowerCase() === "true";

function calledATool(events: readonly BaseEvent[]): boolean {
  return events.some((event) => event.type === "TOOL_CALL_START");
}

function asksForSourceUrls(text: string): boolean {
  return /\b(?:exact\s+)?(?:source\s+)?urls?\b|\bcite\b[^.?!\n]{0,80}\burls?\b/i.test(
    text,
  );
}

function urlsIn(text: string): Set<string> {
  const urls = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    const raw = match[0].replace(/[),.;:!?\]}]+$/g, "");
    try {
      const parsed = new URL(raw);
      parsed.hash = "";
      if (parsed.pathname.length > 1)
        parsed.pathname = parsed.pathname.replace(/\/$/, "");
      urls.add(parsed.toString());
    } catch {
      // A malformed string that merely starts like a URL is not citation evidence.
    }
  }
  return urls;
}

function textFromEvents(events: readonly BaseEvent[], type: string): string {
  return events
    .filter((event) => event.type === type)
    .map((event) => {
      if ("delta" in event && typeof event.delta === "string")
        return event.delta;
      if ("content" in event && typeof event.content === "string")
        return event.content;
      return "";
    })
    .join("\n");
}

/** A citation request is satisfied only by URLs that the retrieval result itself contained. */
function hasRequestedCitationLineage(
  events: readonly BaseEvent[],
  requestText: string,
): boolean {
  if (!asksForSourceUrls(requestText)) return true;
  const cited = urlsIn(textFromEvents(events, "TEXT_MESSAGE_CONTENT"));
  if (cited.size === 0) return false;
  const retrieved = urlsIn(textFromEvents(events, "TOOL_CALL_RESULT"));
  return [...cited].every((url) => retrieved.has(url));
}

function hasRequiredEvidence(
  events: readonly BaseEvent[],
  requestText: string,
): boolean {
  return (
    calledATool(events) && hasRequestedCitationLineage(events, requestText)
  );
}

/** Add literal citations from tool results when a remote transport emitted only linked labels. */
function appendRetrievedUrlCitations(
  events: readonly BaseEvent[],
  requestText: string,
): BaseEvent[] {
  if (!asksForSourceUrls(requestText)) return [...events];
  const cited = urlsIn(textFromEvents(events, "TEXT_MESSAGE_CONTENT"));
  if (cited.size > 0) return [...events];
  const retrieved = [
    ...urlsIn(textFromEvents(events, "TOOL_CALL_RESULT")),
  ].slice(0, 10);
  if (retrieved.length === 0) return [...events];

  const endIndex = events.findLastIndex(
    (event) => event.type === "TEXT_MESSAGE_END",
  );
  if (endIndex < 0) return [...events];
  const end = events[endIndex];
  if (!("messageId" in end) || typeof end.messageId !== "string")
    return [...events];
  const appendix = {
    type: "TEXT_MESSAGE_CONTENT",
    messageId: end.messageId,
    delta: `\n\nRetrieved source URLs:\n${retrieved.map((url) => `- ${url}`).join("\n")}`,
  } as BaseEvent;
  return [...events.slice(0, endIndex), appendix, ...events.slice(endIndex)];
}

/** Collapse buffered text fragments before replay so incremental Markdown cannot race stale state. */
function coalesceTextDeltas(events: readonly BaseEvent[]): BaseEvent[] {
  const compacted: BaseEvent[] = [];
  for (const event of events) {
    const previous = compacted.at(-1);
    if (
      event.type === "TEXT_MESSAGE_CONTENT" &&
      previous?.type === "TEXT_MESSAGE_CONTENT" &&
      "messageId" in event &&
      "messageId" in previous &&
      event.messageId === previous.messageId &&
      "delta" in event &&
      "delta" in previous &&
      typeof event.delta === "string" &&
      typeof previous.delta === "string"
    ) {
      compacted[compacted.length - 1] = {
        ...previous,
        delta: previous.delta + event.delta,
      } as BaseEvent;
    } else {
      compacted.push(event);
    }
  }
  return compacted;
}

function evidenceGateMetrics(
  events: readonly BaseEvent[],
  requestText: string,
) {
  const cited = urlsIn(textFromEvents(events, "TEXT_MESSAGE_CONTENT"));
  const retrieved = urlsIn(textFromEvents(events, "TOOL_CALL_RESULT"));
  return {
    calledTool: calledATool(events),
    citationLineageRequired: asksForSourceUrls(requestText),
    citedUrls: cited.size,
    retrievedUrls: retrieved.size,
    unmatchedCitations: [...cited].filter((url) => !retrieved.has(url)).length,
  };
}

function recordEvidenceGate(
  input: RunAgentInput,
  attempt: "first" | "retry",
  events: readonly BaseEvent[],
  requestText: string,
  accepted: boolean,
) {
  // Counts only: useful proof of enforcement without logging prompts, source URLs or tool results.
  console.info(
    JSON.stringify({
      type: "evidence-gate",
      runId: input.runId,
      attempt,
      accepted,
      ...evidenceGateMetrics(events, requestText),
    }),
  );
}

export type RuntimeEpisodeRecord = {
  run: RunAgentInput;
  episode: VerifiableEpisode;
  scored: ScoredEpisode;
  /** Observable execution metadata only: names/ids and provider usage, never arguments/results. */
  toolCalls: Array<{ id: string; name: string }>;
  usage?: {
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
};

let persistRuntimeEpisode:
  ((record: RuntimeEpisodeRecord) => Promise<void>) | undefined;

/** Install the deployment-owned durable sink once at boot. Tests and embedded runtimes may omit it. */
export function setRuntimeEpisodeRecorder(
  recorder: ((record: RuntimeEpisodeRecord) => Promise<void>) | undefined,
) {
  persistRuntimeEpisode = recorder;
}

let persistContextCapsule:
  | ((input: {
      runId: string;
      threadId: string;
      checksum: string;
      messages: unknown[];
    }) => Promise<void>)
  | undefined;

/** Install the durable store that makes compacted verbatim history retrievable by checksum. */
export function setContextCapsuleRecorder(
  recorder: typeof persistContextCapsule,
) {
  persistContextCapsule = recorder;
}

function recordRuntimeEpisode(
  input: RunAgentInput,
  events: readonly BaseEvent[],
  requireGrounding: boolean,
) {
  const { episode, scored } = verifyRuntimeEpisode({
    run: input,
    events,
    requireGrounding,
  });
  console.info(
    JSON.stringify({
      type: "verifiable-episode",
      runId: input.runId,
      episodeId: episode.id,
      eligibleForTraining: scored.eligibleForTraining,
      scalarReward: scored.scalarReward,
      verifiers: episode.verifierResults.map((result) => ({
        id: result.id,
        version: result.version,
        passed: result.passed,
        score: result.score,
        critical: result.critical === true,
      })),
      reasons: scored.reasons,
    }),
  );
  const toolCalls = events.flatMap((event) => {
    if (event.type !== "TOOL_CALL_START") return [];
    const value = event as BaseEvent & {
      toolCallId?: unknown;
      toolCallName?: unknown;
    };
    return typeof value.toolCallId === "string" &&
      typeof value.toolCallName === "string"
      ? [{ id: value.toolCallId, name: value.toolCallName }]
      : [];
  });
  const finished = [...events]
    .reverse()
    .find((event) => event.type === "RUN_FINISHED") as
    (BaseEvent & { result?: { openbotAnalytics?: unknown } }) | undefined;
  const rawUsage = finished?.result?.openbotAnalytics;
  const usage =
    rawUsage && typeof rawUsage === "object" && !Array.isArray(rawUsage)
      ? Object.fromEntries(
          Object.entries(rawUsage as Record<string, unknown>).filter(
            ([key, value]) =>
              (key === "model" && typeof value === "string") ||
              (["inputTokens", "outputTokens", "totalTokens"].includes(key) &&
                typeof value === "number" &&
                Number.isSafeInteger(value) &&
                value >= 0),
          ),
        )
      : undefined;
  void persistRuntimeEpisode?.({
    run: input,
    episode,
    scored,
    toolCalls,
    ...(usage ? { usage } : {}),
  }).catch((error) => {
    // Analytics must not turn a correct answer into an outage, but a lost episode must be visible.
    console.error(
      JSON.stringify({
        type: "verifiable-episode-persist-failed",
        runId: input.runId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  });
  return scored.eligibleForTraining;
}

function endedWithRunError(events: readonly BaseEvent[]): boolean {
  return events.some((event) => event.type === "RUN_ERROR");
}

async function compactRun(input: RunAgentInput) {
  const compacted = compactMessages(input.messages);
  if (compacted.compacted) {
    if (!persistContextCapsule)
      throw new Error(
        "Context compaction requires a durable verbatim capsule recorder.",
      );
    await persistContextCapsule({
      runId: input.runId,
      threadId: input.threadId,
      checksum: compacted.capsuleChecksum,
      messages: compacted.omittedArtifact,
    });
    console.info(
      JSON.stringify({
        type: "context-compacted",
        runId: input.runId,
        omittedMessages: compacted.omittedMessages,
        capsuleChecksum: compacted.capsuleChecksum,
      }),
    );
  }
  return {
    compacted,
    input: compacted.compacted
      ? { ...input, messages: compacted.messages }
      : input,
  };
}

function exposeCompactionEvent(
  event: BaseEvent,
  omittedMessages: number,
): BaseEvent {
  if (event.type !== "RUN_FINISHED" || omittedMessages < 1) return event;
  const current =
    event.result &&
    typeof event.result === "object" &&
    !Array.isArray(event.result)
      ? event.result
      : {};
  return {
    ...event,
    result: {
      ...current,
      openbotContextCompaction: { omittedMessages },
    },
  };
}

/** Compact every long run, including ordinary requests that do not enter the evidence gate. */
export function runWithContextCompaction(
  input: RunAgentInput,
  runAttempt: (input: RunAgentInput) => Observable<BaseEvent>,
): Observable<BaseEvent> {
  return defer(() => compactRun(input)).pipe(
    switchMap((prepared) => {
      const observed: BaseEvent[] = [];
      return runAttempt(prepared.input).pipe(
        tap((event) => observed.push(event)),
        map((event) =>
          exposeCompactionEvent(event, prepared.compacted.omittedMessages),
        ),
        tap({
          complete: () => recordRuntimeEpisode(prepared.input, observed, false),
        }),
      );
    }),
  );
}

async function eventsFromObservable(
  events: Observable<BaseEvent>,
): Promise<BaseEvent[]> {
  return lastValueFrom(events.pipe(toArray()));
}

/** Replace an unsupported draft with one honest, protocol-complete assistant message. */
function noEvidenceEvents(
  events: readonly BaseEvent[],
  input: RunAgentInput,
): BaseEvent[] {
  const started = events.find((event) => event.type === "RUN_STARTED");
  const finished = [...events]
    .reverse()
    .find((event) => event.type === "RUN_FINISHED");
  const messageId = `evidence-required:${input.runId}`;
  return [
    started ??
      ({
        type: "RUN_STARTED",
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent),
    {
      type: "TEXT_MESSAGE_START",
      messageId,
      role: "assistant",
    } as BaseEvent,
    {
      type: "TEXT_MESSAGE_CONTENT",
      messageId,
      delta: NO_EVIDENCE_ANSWER,
    } as BaseEvent,
    { type: "TEXT_MESSAGE_END", messageId } as BaseEvent,
    finished ??
      ({
        type: "RUN_FINISHED",
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent),
  ];
}

/**
 * Run once, retry once with a corrective system instruction when no evidence tool was called, then
 * fail honestly rather than publish an unsupported verification claim.
 *
 * Events are buffered only for requests whose definition of done explicitly includes evidence. A
 * first draft with no tool is never emitted or persisted; a successful retry is the one observable
 * run. This turns “try another approach” into runtime behavior and makes the final fallback
 * deterministic when the model ignores the correction too.
 */
export function runWithEvidenceRequirement(
  agent: AbstractAgent,
  input: RunAgentInput,
): Observable<BaseEvent> {
  let attempt = 0;
  return runEvidenceAttempts(input, (attemptInput) => {
    const running = attempt === 0 ? agent : agent.clone();
    attempt += 1;
    return running.run(attemptInput);
  });
}

/** Shared by built-in agents and remote middleware so neither execution path can bypass the gate. */
function runEvidenceAttempts(
  input: RunAgentInput,
  runAttempt: (input: RunAgentInput) => Observable<BaseEvent>,
): Observable<BaseEvent> {
  return defer(async () => {
    try {
      const prepared = await compactRun(input);
      const { compacted } = prepared;
      const runInput = prepared.input;
      const exposeCompaction = (events: BaseEvent[]): BaseEvent[] => {
        if (!compacted.compacted) return events;
        return events.map((event) =>
          exposeCompactionEvent(event, compacted.omittedMessages),
        );
      };
      const requestText = latestUserText(runInput.messages);
      const first = coalesceTextDeltas(
        await eventsFromObservable(runAttempt(runInput)),
      );
      const firstEligible = recordRuntimeEpisode(
        runInput,
        first,
        asksForSourceUrls(requestText),
      );
      const firstAccepted =
        hasRequiredEvidence(first, requestText) && firstEligible;
      recordEvidenceGate(input, "first", first, requestText, firstAccepted);
      if (firstAccepted || endedWithRunError(first))
        return exposeCompaction(first);

      /*
       * A retry may repeat every tool the first draft already executed. That is harmless for a
       * search and catastrophic for a tool that sent a message, changed infrastructure or charged
       * money. Retry only the case the corrective instruction was designed for: the model did not
       * call a tool at all. Once any tool ran, an unsupported answer fails closed and the caller can
       * deliberately start another run instead of this gate silently replaying side effects.
       */
      if (calledATool(first)) {
        return exposeCompaction(noEvidenceEvents(first, input));
      }

      const retry = coalesceTextDeltas(
        await eventsFromObservable(
          runAttempt({
            ...runInput,
            messages: [
              {
                id: `evidence-retry:${input.runId}`,
                role: "system",
                content: EVIDENCE_RETRY_INSTRUCTION,
              },
              ...runInput.messages,
            ],
          }),
        ),
      );
      const repairedRetry = EVIDENCE_AUTO_CITE
        ? appendRetrievedUrlCitations(retry, requestText)
        : retry;
      const retryEligible = recordRuntimeEpisode(
        runInput,
        repairedRetry,
        asksForSourceUrls(requestText),
      );
      const retryAccepted =
        hasRequiredEvidence(repairedRetry, requestText) && retryEligible;
      recordEvidenceGate(
        input,
        "retry",
        repairedRetry,
        requestText,
        retryAccepted,
      );
      if (retryAccepted || endedWithRunError(retry)) {
        return exposeCompaction(repairedRetry);
      }
      return exposeCompaction(noEvidenceEvents(retry, input));
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "evidence-gate-error",
          runId: input.runId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        }),
      );
      throw error;
    }
  }).pipe(switchMap((events) => from(events)));
}

class EvidenceRequiredAgent extends AbstractAgent {
  private inner: AbstractAgent;

  constructor(
    identity: { agentId: string; description: string },
    inner: AbstractAgent,
  ) {
    super(identity);
    this.inner = inner;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return runWithEvidenceRequirement(this.inner, input);
  }

  getCapabilities() {
    return this.inner.getCapabilities?.() ?? Promise.resolve({});
  }

  abortRun(): void {
    this.inner.abortRun();
    super.abortRun();
  }
}

class ContextCompactedAgent extends AbstractAgent {
  constructor(
    identity: { agentId: string; description: string },
    private readonly inner: AbstractAgent,
  ) {
    super(identity);
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return runWithContextCompaction(input, (prepared) =>
      this.inner.run(prepared),
    );
  }

  getCapabilities() {
    return this.inner.getCapabilities?.() ?? Promise.resolve({});
  }

  abortRun(): void {
    this.inner.abortRun();
    super.abortRun();
  }
}

/**
 * Build the built-in and remote AG-UI agent map the runtime serves.
 *
 * Keyed by the registry id, which is what the browser sends as the agent name, so the two cannot
 * drift apart without the lookup failing loudly rather than silently running the wrong Bot.
 */
export async function buildAgents(
  agents: RegisteredAgent[],
  model: RuntimeModel,
  apiKey: string | null,
  /** Absent leaves every stream unwatched, which is what an unconfigured timeout means. */
  stallGuard?: StallGuard,
  /** Absent leaves every Bot with no tools, which is the correct answer when nothing is granted. */
  loadTools: LoadToolsForBot = async () => [],
  signRun?: SignRun,
  /** What every built-in Bot is told about the computer. Absent means this deployment has none. */
  computerGuidance?: string,
  /**
   * Which vendors this deployment connects to. Asked once per build rather than per Bot, because it
   * is a fact about the deployment; what differs per Bot is which of them it holds.
   */
  loadVendors: () => Promise<readonly string[]> = async () => [],
  /** How a run's tools are narrowed to what it is about. Absent means they are not. */
  selection?: ToolSelection,
  /**
   * The fetch a remote agent is dialled with.
   *
   * Absent uses the runtime's own, which follows redirects wherever they point. A deployment passes
   * one that re-checks each hop, because the address a registration was validated against and the
   * address a run finally reaches are only the same address while nobody redirects.
   */
  agentFetch?: AgentFetch,
  /** How a run gets its tool for handing work on. Absent means no Bot is offered one. */
  handoff?: HandoffForRun,
  /** Total/idle deadline for a built-in run. Zero explicitly disables it. */
  runTimeoutMs = 120_000,
): Promise<Record<string, AbstractAgent>> {
  const vendors = await loadVendors().catch(() => [] as readonly string[]);
  return Object.fromEntries(
    await Promise.all(
      agents.map(async (agent) => [
        agent.id,
        await buildAgent(
          agent,
          model,
          apiKey,
          stallGuard,
          loadTools,
          signRun,
          computerGuidance,
          vendors,
          selection,
          agentFetch,
          handoff,
          runTimeoutMs,
        ),
      ]),
    ),
  );
}

async function buildAgent(
  agent: RegisteredAgent,
  model: RuntimeModel,
  apiKey: string | null,
  stallGuard: StallGuard | undefined,
  loadTools: LoadToolsForBot,
  signRun?: SignRun,
  computerGuidance?: string,
  connectedVendors: readonly string[] = [],
  selection?: ToolSelection,
  agentFetch?: AgentFetch,
  handoff?: HandoffForRun,
  runTimeoutMs = 120_000,
): Promise<AbstractAgent> {
  if (agent.type === "unavailable") {
    return new UnavailableAgent(agent);
  }

  const granted = await loadTools(agent.id);

  /*
   * Whether narrowing can do anything here at all.
   *
   * A skill that declares no tools is not a unit of retrieval, and a catalogue already small enough
   * to choose from has nothing to gain. In both cases the Bot is built exactly as it was before any
   * of this existed: no deferral, no per-run model call, nothing to go wrong. That is most
   * deployments on their first day, and they should not pay for a feature they are not using.
   */
  const skills = selection
    ? await selection.loadSkills(agent.id).catch(() => [])
    : [];
  const narrowing =
    selection &&
    skills.some((skill) => skill.tools.length > 0) &&
    granted.length > (selection.floor ?? SELECTION_FLOOR)
      ? selection
      : undefined;

  /** Pass one and pass two, for one run. Shared by both agent kinds; each applies it differently. */
  const offeredFor = async (input: RunAgentInput): Promise<GrantedTool[]> => {
    if (!narrowing) return granted;
    const chosen = await selectTools({
      tools: granted,
      skills,
      text: latestUserText(input.messages),
      choose: narrowing.choose,
      ...(narrowing.floor === undefined ? {} : { floor: narrowing.floor }),
    });
    // Awaited, so the row is on record before the model is handed the tools it names. A discovery
    // written afterwards would sit in the trail after the calls it explains.
    await narrowing.record?.(agent.id, chosen).catch(() => {});
    return chosen.offered;
  };

  if (agent.type === "remote_ag_ui") {
    /*
     * The remote path narrows inside its own middleware rather than by being wrapped.
     *
     * `.use()` middleware is applied by `runAgent`, not by `run`, so an outer agent delegating to
     * `remote.run(input)` skips it: the endpoint would get a run with no standing role, no holdings
     * message, no tools and no signed assertion, and every one of those failures is silent.
     *
     * Reach tools are also resolved per run. The remote endpoint receives only their descriptions
     * and the deployment-signed run assertion; execution comes back through the authenticated
     * callback, where this deployment re-resolves the tools against current grants, caps and depth.
     * That keeps a remote Bot from gaining a reach tool by naming one it was not offered.
     */
    const toolsForRun =
      narrowing || handoff
        ? async (input: RunAgentInput) => {
            const offered = narrowing ? await offeredFor(input) : granted;
            const reaching = (await handoff?.(agent.id, input)) ?? [];
            return reaching.length > 0 ? [...offered, ...reaching] : offered;
          }
        : undefined;
    return remoteAgentWithStandingRole(
      agent,
      stallGuard,
      granted,
      signRun,
      connectedVendors,
      toolsForRun,
      agentFetch,
    );
  }

  /*
   * A built-in Bot takes its tools in its configuration, so narrowing means building it again once
   * the message is known. The guidance it is given is generated from the tools passed here, which is
   * what keeps a narrowed run from being told it holds something it was not offered.
   */
  const withTools = (tools: GrantedTool[]) =>
    new BuiltInAgent(
      builtInAgentConfiguration(
        agent,
        model,
        apiKey,
        tools,
        computerGuidance,
        connectedVendors,
      ),
    );

  const whole = withTools(granted);

  /*
   * Every built-in run goes through RunBuiltAgent, even when this deployment has neither adaptive
   * selection nor handoff. Evidence enforcement is a run property derived from the person's latest
   * message; returning `whole` here used to bypass it completely on the simplest deployment. That
   * exact path produced a confident, source-citing live answer with zero tool calls.
   */
  return new RunBuiltAgent(
    { agentId: agent.id, description: agent.name },
    whole,
    async (input) => {
      const offered = narrowing ? await offeredFor(input) : granted;
      /*
       * The tool for handing work to another Bot is made per run, not per request.
       *
       * It has to know which run is asking: how deep the chain already is, and which conversation an
       * answer belongs in. Both live on the run rather than on the request, and both have to be this
       * deployment's own statement rather than anything the model can edit. A request is earlier
       * than a run and knows neither.
       */
      const passing = (await handoff?.(agent.id, input)) ?? [];
      const tools = passing.length > 0 ? [...offered, ...passing] : offered;
      // Nothing added and nothing narrowed means nothing to rebuild, and reusing the agent already
      // built for this request keeps that path allocation-for-allocation what it was.
      const built =
        tools.length === granted.length && passing.length === 0
          ? whole
          : withTools(tools);
      /*
       * Evidence requirements fail closed even when selection or grants leave this run with no
       * tools. That absence is exactly when an answer from memory is most tempting and least able
       * to satisfy the request. The wrapper will replace both memory-only attempts with an honest
       * limitation instead of silently opting out of enforcement.
       */
      return requiresToolEvidence(latestUserText(input.messages))
        ? new EvidenceRequiredAgent(
            { agentId: agent.id, description: agent.name },
            built,
          )
        : new ContextCompactedAgent(
            { agentId: agent.id, description: agent.name },
            built,
          );
    },
    runTimeoutMs,
  );
}

/**
 * The tools a run gets for reaching past itself: handing work to another Bot, and asking a person.
 *
 * Given the Bot and the run, because the answers depend on both: which Bots this one has been
 * granted, and how deep the chain it is already part of has gone. Empty means this run reaches
 * nobody, which is the right shape for a deployment with the capability switched off.
 *
 * The two arrive together because a model chooses between them. Offering the way to hand work
 * sideways without the way to stop and ask leaves the model one exit from a decision it cannot make,
 * and it takes it: it asks a Bot that cannot settle the question either.
 */
export type HandoffForRun = (
  botId: string,
  input: RunAgentInput,
) => Promise<readonly GrantedTool[]>;

/**
 * How a deployment narrows a Bot's tools to the ones a run is about. Absent means it does not.
 *
 * Three collaborators rather than one, because they fail differently and are configured in
 * different places: the skills come from the plugin store, the choosing is a model call on the
 * deployment's own key, and the record goes to the audit trail. A deployment missing any of them
 * should lose the narrowing and keep the Bot, which is why `record` is optional and the other two
 * are allowed to throw.
 */
export type ToolSelection = {
  /** What this Bot's granted skills declare. Failure is treated as "no skills". */
  loadSkills: (botId: string) => Promise<SelectableSkill[]>;
  /** Pass one. Returns the model's raw answer; throwing means the narrowing is skipped. */
  choose: (prompt: string) => Promise<string | null>;
  /** Writes the discovery row. Never allowed to fail a run. */
  record?: (botId: string, selection: Selection<GrantedTool>) => Promise<void>;
  /** Overrides the default catalogue size below which nothing is narrowed. */
  floor?: number;
};

/**
 * A remote AG-UI agent that states its standing role on every run.
 *
 * This is standard AG-UI middleware rather than a request transformation on one provider's client,
 * so the same coworker works against any endpoint that speaks the protocol. Any copy of the standing
 * message already in the conversation is dropped: the endpoint must receive exactly one, first,
 * however many times the thread has been replayed.
 *
 * The stall watch goes on the fetch rather than into that middleware, because the middleware works
 * in AG-UI events and a stall is the absence of one. The thing that has to be watched is the
 * response body, and the fetch is where this deployment still holds it.
 */
function remoteAgentWithStandingRole(
  agent: RegisteredRemoteAgent,
  stallGuard: StallGuard | undefined,
  /**
   * What this Bot was granted, described rather than executable.
   *
   * A framework Bot runs its own loop and calls these back through `/api/agent-tools/call`, so what
   * it needs from here is the offer: the name, what the tool is for, and the arguments it takes.
   * The executing half stays on this side, where the grant and the policy are.
   */
  tools: GrantedTool[] = [],
  signRun?: SignRun,
  /** As for the built-in path: what this deployment connects to, held or not. */
  connectedVendors: readonly string[] = [],
  /**
   * Which of those tools this run is about, decided once the message is known.
   *
   * NARROWED HERE RATHER THAN BY WRAPPING THE AGENT, and the difference is not cosmetic. Middleware
   * registered with `.use()` is applied by `runAgent`, not by `run`: an outer agent that delegated
   * to `remote.run(input)` would skip this whole function's work, and the endpoint would receive a
   * run with no standing role, no holdings message, no tools and no signed assertion. Every one of
   * those is silent — the Bot simply answers worse — so the narrowing goes inside the middleware
   * that is already here.
   *
   * Absent means no narrowing, which is the behaviour every deployment had before this existed.
   */
  narrow?: (input: RunAgentInput) => Promise<GrantedTool[]>,
  /** The fetch this agent is dialled with. See {@link buildAgents}. */
  agentFetch?: AgentFetch,
) {
  const remote = new HttpAgent({
    url: agent.endpoint,
    agentId: agent.id,
    // The customer's own key, if their agent sits behind one. `HttpAgentConfig` is
    // `{ url, headers?, fetch? }`, verified against @ag-ui/client 0.0.57.
    ...(agent.headers ? { headers: agent.headers } : {}),
    // The watch wraps whichever fetch is underneath, so a deployment gets both the stall timeout and
    // the redirect check rather than having to choose.
    ...(stallGuard
      ? {
          fetch: stallGuard.watch(
            { id: agent.id, name: agent.name },
            agentFetch,
          ),
        }
      : agentFetch
        ? { fetch: agentFetch }
        : {}),
  });
  /*
   * What this Bot holds, as a second standing message.
   *
   * Beside the role rather than inside it, because the role comes from the package and this comes
   * from the grants: they change for different reasons and at different times. Sent on every run for
   * the same reason the tools are, so switching a connector on reaches the next run.
   *
   * The remote path needs this more than the built-in one, not less. A framework Bot is handed the
   * tools as an offer and decides for itself what to call, with `COMPUTER_GUIDANCE` as its whole
   * prompt — a page about the browser that mentions connectors nowhere. That is the Bot that browsed
   * to drive.google.com holding four Drive tools.
   *
   * Built from the tools this run was offered rather than from everything granted, so a narrowed
   * run is never told it holds a system it cannot reach on this turn.
   */
  const holdingsMessageFor = (offered: GrantedTool[]) => {
    const holdings = grantedToolGuidance(offered, connectedVendors);
    return holdings
      ? {
          id: `granted-tools:${agent.id}`,
          role: "system" as const,
          content: holdings,
        }
      : null;
  };

  const runWith = (
    tools: GrantedTool[],
    input: RunAgentInput,
    next: AbstractAgent,
  ) => {
    const holdingsMessage = holdingsMessageFor(tools);
    return next.run({
      ...input,
      messages: [
        agent.standingMessage,
        ...(holdingsMessage ? [holdingsMessage] : []),
        ...input.messages.filter(
          (message) =>
            message.id !== agent.standingMessage.id &&
            message.id !== holdingsMessage?.id,
        ),
      ],
      /*
       * The Bot's own grants, added to whatever the surface offered.
       *
       * Sent on every run rather than configured once on the endpoint, because a grant an
       * administrator adds or revokes has to apply to the next run and the endpoint is somebody
       * else's process.
       */
      tools: [
        ...(input.tools ?? []),
        ...tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: z.toJSONSchema(tool.parameters) as Record<
            string,
            unknown
          >,
        })),
      ],
      // Who the Bot is calling back as, so the audit row names it rather than "an agent".
      forwardedProps: {
        ...(input.forwardedProps ?? {}),
        openbotBotId: agent.id,
        /*
         * Which of those tools this deployment runs, as opposed to the surface.
         *
         * `tools` mixes two kinds that a name cannot tell apart: the Bot's grants, which execute
         * here through the policy and the audit trail, and the components the browser draws. A Bot
         * that ran the second kind through this deployment asked it to execute a chart, was told it
         * could not, and then apologised to the person for not showing the chart that was on screen
         * in front of them. Only this side knows which is which, so only this side can say.
         */
        openbotDeploymentTools: tools.map((tool) => tool.name),
        /*
         * This deployment's own statement of what this run is.
         *
         * Signed, short-lived, and naming the Bot and the person. The agent hands it back when it
         * calls a tool, and that is where the Bot and the actor come from: its own token says which
         * agent is calling, and this says who it is calling for. Neither is taken from the request
         * body any more, which is what used to make the audit trail forgeable by anything holding
         * one shared secret.
         */
        ...(signRun
          ? (() => {
              const signed = signRun(agent.id, input.runId, input.threadId);
              return {
                openbotRun: signed.lineage,
                openbotToolRuns: signed.toolCalls,
              };
            })()
          : /*
             * Absent means this deployment cannot sign, so the agent is given nothing to hand back
             * and its tool calls will be refused. That is the right direction to fail: a Bot that
             * cannot prove whose run it is should not be spending anybody's grants.
             */
            {}),
      },
    } as never);
  };

  /*
   * Deferred, because choosing the tools is a model call and middleware has to answer with a stream
   * straight away. `defer` puts the work on the subscription, which is where the run actually
   * begins, so nothing happens until somebody is listening and a retried run chooses again.
   */
  remote.use((input, next) =>
    defer(() =>
      from(narrow ? narrow(input) : Promise.resolve(tools)).pipe(
        switchMap((offered) => {
          const run = (attemptInput: RunAgentInput) =>
            runWith(offered, attemptInput, next);
          return requiresToolEvidence(latestUserText(input.messages))
            ? runEvidenceAttempts(input, run)
            : runWithContextCompaction(input, run);
        }),
      ),
    ),
  );

  return remote;
}

/**
 * Put a total deadline around one built-in run.
 *
 * Remote agents have a byte-level stall guard because their failure mode is a socket that remains
 * open without producing another event. A built-in agent has no fetch seam; its observable is the
 * boundary we own. Zero remains an explicit operator escape hatch, matching AGENT_STALL_TIMEOUT_MS.
 */
export function runWithAgentDeadline(
  input: RunAgentInput,
  run: () => Observable<BaseEvent>,
  timeoutMs: number,
  abort: () => void,
): Observable<BaseEvent> {
  if (timeoutMs <= 0) return run();
  return run().pipe(
    takeUntil(
      timer(timeoutMs).pipe(
        mergeMap(() => throwError(() => new TimeoutError())),
      ),
    ),
    catchError((error) => {
      if (!(error instanceof TimeoutError)) return throwError(() => error);
      abort();
      return throwError(
        () =>
          new Error(
            `Bot run ${input.runId} timed out after ${timeoutMs}ms without completing.`,
          ),
      );
    }),
  );
}

/**
 * An agent whose tools are decided when the run starts, because that is the first moment anybody
 * knows what the run is about, and who is asking on whose behalf.
 *
 * WHY A WRAPPER AND NOT A NARROWER `loadTools`. Tools are resolved per request, and a request is
 * earlier than a run: at that point there is a Bot and a person and no message, so there is nothing
 * to select against. `run(input)` is the first place the message exists. Both underlying agents take
 * their tools at construction — a built-in one in its configuration, a remote one in the middleware
 * that sends them — so the only way to hand either a set chosen from the message is to build it
 * after the message arrives. That is all this does: it defers `build` to the first subscription and
 * then gets out of the way.
 *
 * The deferral is per subscription, so a retried run reselects rather than reusing a decision made
 * for a message that is no longer the last one.
 */
class RunBuiltAgent extends AbstractAgent {
  /**
   * The agent this run turned into, once there is one.
   *
   * Held only so `abortRun` can reach it. Without this, pressing stop aborts a wrapper that is not
   * doing anything and leaves the model call underneath it running to completion, spending the
   * deployment's money on an answer nobody will see.
   */
  private inner?: AbstractAgent;
  /** The same Bot with nothing narrowed, kept to answer questions that are not about one run. */
  private whole: AbstractAgent;
  private build: (input: RunAgentInput) => Promise<AbstractAgent>;
  private runTimeoutMs: number;

  constructor(
    identity: { agentId: string; description: string },
    whole: AbstractAgent,
    build: (input: RunAgentInput) => Promise<AbstractAgent>,
    runTimeoutMs = 120_000,
  ) {
    super(identity);
    this.whole = whole;
    this.build = build;
    this.runTimeoutMs = runTimeoutMs;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return defer(() =>
      from(this.build(input)).pipe(
        switchMap((agent) => {
          this.inner = agent;
          return runWithAgentDeadline(
            input,
            () => agent.run(input),
            this.runTimeoutMs,
            () => agent.abortRun(),
          );
        }),
      ),
    );
  }

  /**
   * What the Bot can do, answered from the un-narrowed agent.
   *
   * Capabilities are asked for outside a run, where there is no message and so nothing to select
   * against. They are also a fact about the Bot rather than about one turn: a deployment that
   * narrowed this run to three tools has not stopped supporting whatever the underlying agent
   * supports.
   */
  getCapabilities() {
    return this.whole.getCapabilities?.() ?? Promise.resolve({});
  }

  /**
   * Carried by hand, because `AbstractAgent.clone` does not know this class exists.
   *
   * It builds a bare object on the prototype and copies a fixed list of base fields onto it, so
   * every field declared here arrives `undefined`. The runtime clones an agent before every run
   * (`agents[agentId].clone()`), which means the omission is not a corner case: without this, the
   * first message anybody sends fails on a `build` that is not a function.
   */
  clone(): RunBuiltAgent {
    const cloned = super.clone() as RunBuiltAgent;
    cloned.whole = this.whole;
    cloned.build = this.build;
    cloned.runTimeoutMs = this.runTimeoutMs;
    // Deliberately not the inner agent. A clone is a new run, and inheriting the last run's agent
    // would point `abortRun` at something already finished.
    cloned.inner = undefined;
    return cloned;
  }

  abortRun(): void {
    this.inner?.abortRun();
    super.abortRun();
  }
}

class UnavailableAgent extends AbstractAgent {
  private readonly reason: string;

  constructor(agent: RegisteredUnavailableAgent) {
    super({ agentId: agent.id, description: agent.name });
    this.reason = agent.reason;
  }

  // Refused here rather than at the endpoint: a deleted coworker has no endpoint worth contacting,
  // and the person is owed the reason rather than a transport error.
  run(): never {
    throw new Error(this.reason);
  }
}

export async function resolveRuntimeAgents(
  loadAgents: () => Promise<RegisteredAgent[]>,
  model: RuntimeModel,
  resolveModelApiKey: () => Promise<string | null>,
  stallGuard?: StallGuard,
  loadTools?: LoadToolsForBot,
  signRun?: SignRun,
  computerGuidance?: string,
  loadVendors?: () => Promise<readonly string[]>,
  selection?: ToolSelection,
  agentFetch?: AgentFetch,
  /** How a run gets its tool for handing work on. Absent means no Bot is offered one. */
  handoff?: HandoffForRun,
  /**
   * Build only this one, when the caller wants only this one.
   *
   * A hop delivery and a routine's turn each want a single Bot, and both were resolving the whole
   * roster to reach it: every registered Bot constructed, and a granted-tools query for each, with
   * all but one thrown away. On a hop that is paid again on every retry. The roster is still LOADED
   * in full, because which Bots exist for this person is what decides whether the one asked for is
   * theirs to see at all; what narrows is what gets built.
   */
  onlyBotId?: string,
  runTimeoutMs = 120_000,
): Promise<Record<string, AbstractAgent>> {
  const all = await loadAgents();
  if (all.length === 0) {
    throw new Error(
      "No agents are registered. Add one to the tenant package or the agents table.",
    );
  }
  const registered =
    onlyBotId === undefined
      ? all
      : all.filter((agent) => agent.id === onlyBotId);
  // Not an error: a caller asking for a Bot this person cannot see gets an empty result and decides
  // what that means, exactly as it would have from a roster that did not contain it.
  if (registered.length === 0) return {};

  const apiKey = registered.some((agent) => agent.type === "built_in")
    ? await resolveModelApiKey()
    : null;
  return buildAgents(
    registered,
    model,
    apiKey,
    stallGuard,
    loadTools,
    signRun,
    computerGuidance,
    loadVendors,
    selection,
    agentFetch,
    handoff,
    runTimeoutMs,
  );
}

/** What one Bot may call, for the person whose request this is. */
export type LoadToolsForBot = (botId: string) => Promise<GrantedTool[]>;

/**
 * The deployment's signed statement of what a run is, for the agent that will run it.
 *
 * A closure rather than a key passed down, so the encryption key stays in the module that owns
 * configuration and this one never holds a secret. Shaped like `LoadToolsForBot` on purpose: both are
 * per-actor facts resolved once per request and asked per Bot.
 */
export type SignRun = (
  botId: string,
  runId: string,
  /** Which conversation, so a Bot handing work on cannot choose where the answer lands. */
  threadId: string,
) => { lineage: string; toolCalls: string[] };

/** Who is asking. Agent visibility is decided per person, so a run has to know this first. */
export type IdentifyActor = (request: Request) => Promise<AgentActor>;

/** Loads exactly the agents one person may see, already carrying their standing roles. */
export type LoadAgentsForActor = (
  actor: AgentActor,
) => Promise<RegisteredAgent[]>;

/**
 * Build the runtime's per-request agent factory.
 *
 * Resolution is per request, not per boot, because who may run a coworker is a property of the
 * person asking: a private coworker must be absent for everybody else, and a role edited a moment
 * ago must apply to the next run without a restart. Both fall out of rebuilding the map here.
 */
export function createRequestAgents(
  identifyActor: IdentifyActor,
  loadAgents: LoadAgentsForActor,
  model: RuntimeModel,
  resolveModelApiKey: () => Promise<string | null>,
  /**
   * Shared across every request rather than built per run, because it is the thing that has to
   * outlive one: the sweep that notices a silent stream has to still be running after the request
   * that opened it has been answered.
   */
  stallGuard?: StallGuard,
  /** What each Bot may call, resolved for whoever is asking. Absent means no tools. */
  loadToolsForActor?: (actorId: string) => LoadToolsForBot,
  /** Resolved per request, because what it signs is who this request turned out to be. */
  signRunForActor?: (actorId: string) => SignRun,
  /** What every built-in Bot is told about the computer. Absent means this deployment has none. */
  computerGuidance?: string,
  /** Which vendors this deployment connects to, held by a Bot or not. Absent means none. */
  loadVendors?: () => Promise<readonly string[]>,
  /**
   * How a run's tools are narrowed, resolved for whoever is asking.
   *
   * Per actor like the tools themselves, because the skills a Bot holds are read through the same
   * grants, and because the discovery row has to name the person the run belongs to.
   */
  selectionForActor?: (actorId: string) => ToolSelection,
  /** The fetch remote agents are dialled with. See {@link buildAgents}. */
  agentFetch?: AgentFetch,
  /**
   * How a run gets its tool for handing work to another Bot, resolved for whoever is asking.
   *
   * Per actor for the same reason the tools are: which Bots may be reached is decided against the
   * roster that person can see, so a Bot must never be able to address one they cannot.
   */
  handoffForActor?: (actorId: string) => HandoffForRun,
  runTimeoutMs = 120_000,
) {
  return async ({ request }: { request: Request }) => {
    const actor = await identifyActor(request);
    return resolveRuntimeAgents(
      () => loadAgents(actor),
      model,
      resolveModelApiKey,
      stallGuard,
      loadToolsForActor?.(actor.id),
      signRunForActor?.(actor.id),
      computerGuidance,
      loadVendors,
      selectionForActor?.(actor.id),
      agentFetch,
      handoffForActor?.(actor.id),
      undefined,
      runTimeoutMs,
    );
  };
}

/**
 * Mount the CopilotKit endpoint onto the host Hono app.
 *
 * `agents` is a factory rather than a fixed map so a Bot registered while the server is running is
 * reachable on the next request. Resolving once at boot would mean every new Bot needed a restart,
 * which is not a property you can explain to somebody who just created one.
 */
/**
 * Whether this failure means "the platform has never heard of that thread".
 *
 * A thread id is minted before the thread exists — the platform creates it on the first run — so
 * reading history on a brand-new conversation is the normal opening move, and the platform answers
 * `THREAD_NOT_FOUND` with a 404. The runtime's own handler catches everything and returns a bare 500,
 * so every new chat produced one, with a stack trace behind it.
 *
 * Matched on the shape rather than with `instanceof`. The class is `PlatformRequestError` and it
 * carries `.status` for exactly this — its own documentation gives `error.status === 404` as the
 * example — but it is not re-exported from `@copilotkit/runtime/v2`, and the package's `exports` map
 * offers no subpath that reaches it, so there is no type to test against. The name is set by the
 * constructor and the status is a number on the instance; both are checked, so an unrelated error
 * carrying a `status` of 404 does not qualify.
 *
 * 404 ONLY, and nothing wider. A 500 from the platform means an outage or a bad key, and answering
 * that with an empty history would tell the browser the conversation is gone and invite somebody to
 * start it over. That is the failure this must not introduce while removing the noisy one.
 */
export function isMissingThread(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "PlatformRequestError" &&
    (error as { status?: unknown }).status === 404
  );
}

/**
 * Read a thread's history, treating a thread the platform does not know about as having none.
 *
 * Takes the read as a function rather than being folded into the class below, so the decision can be
 * exercised against a function that really throws. The previous attempt at this fix
 * (#71) was tested by re-implementing its middleware inside the test file, which passes with the real
 * code deleted; this is the actual code path in both places.
 */
export async function historyOrEmpty<T>(
  read: () => Promise<T>,
  whenMissing: T,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (isMissingThread(error)) return whenMissing;
    throw error;
  }
}

/**
 * The platform client, with one answer corrected.
 *
 * A subclass rather than a wrapper. The runtime is handed this object and calls many methods on it,
 * and the base class keeps its state in `#private` fields — which a `Proxy` cannot forward, because a
 * method invoked with the proxy as `this` cannot reach them. Extending keeps every other method
 * exactly as it was, on the instance that owns those fields.
 *
 * `getThreadMessages` is the only override. `handleGetThreadMessages` in the runtime calls it and
 * returns `Response.json` of whatever comes back, so an empty history here is the `{ messages: [] }`
 * the browser expects and a 200 instead of a 500.
 */
class IntelligenceKnowingANewThread extends CopilotKitIntelligence {
  override getThreadMessages(
    params: Parameters<CopilotKitIntelligence["getThreadMessages"]>[0],
  ) {
    return historyOrEmpty(() => super.getThreadMessages(params), {
      messages: [],
    });
  }
}

/**
 * How long a conversation's lock is held before it lapses on its own.
 *
 * Matches the platform's own default rather than picking a number: this is renewed while a Bot works,
 * so what it really sets is how long a conversation stays stuck after a process dies mid-run.
 */
const THREAD_LOCK_TTL_SECONDS = 120;

export function mountCopilotRuntime(
  config: DeploymentConfig,
  model: RuntimeModel,
  loadAgents: LoadAgentsForActor,
  resolveModelApiKey: () => Promise<string | null>,
  identifyUser: IdentifyUser,
  identifyActor: IdentifyActor,
  /**
   * The watch on Bot streams. Not optional, unlike the parameter it forwards to: a guard built from
   * a timeout of zero already watches nothing, so an unconfigured deployment has one to hand and
   * there is no reason for a caller to have to say `undefined` here to reach `basePath`.
   */
  stallGuard: StallGuard,
  loadToolsForActor?: (actorId: string) => LoadToolsForBot,
  signRunForActor?: (actorId: string) => SignRun,
  basePath = "/api/copilotkit",
  loadVendors?: () => Promise<readonly string[]>,
  selectionForActor?: (actorId: string) => ToolSelection,
  /** The fetch remote agents are dialled with. See {@link buildAgents}. */
  agentFetch?: AgentFetch,
  /** How a run gets its tool for handing work on. Absent means no Bot is offered one. */
  handoffForActor?: (actorId: string) => HandoffForRun,
  /**
   * Told when a run starts and ends on a thread, so a channel can show it is working.
   *
   * The universal seam: every run the runtime processes — a person's own turn, a headless hop —
   * takes and gives back the thread lock, and it does so on the server, so a person who sends a
   * message and navigates away still lights the channel they left. A side effect only: it is never
   * awaited in the lock path and a failure in it never touches whether the lock was taken.
   */
  onRunBusy?: (input: { threadId: string; busy: boolean }) => void,
) {
  const { intelligence } = config.runtime;

  /**
   * The same Bot a person's run would get, built without a request.
   *
   * Handed out from here rather than assembled again elsewhere, because "built exactly the way a
   * person's run builds it" is a property worth guaranteeing structurally. A hop delivering to a Bot
   * assembled by parallel wiring would drift the first time one of these arguments changed, and the
   * drift would be invisible: the Bot would run, and quietly hold different tools or a different
   * role from the one the person talks to.
   */
  const agentFor = async (input: {
    /**
     * The person, WITH THEIR ROLE, rather than an id this rebuilds a role for.
     *
     * An administrator sees Bots a user does not. Assumed to be a user here while the desk resolved
     * the real role, the two disagreed in the worst direction: the desk accepted an administrator's
     * hop to a Bot only they can see, the model was told it had been handed over, and then every
     * delivery attempt failed to build that Bot and the person was told it never answered. A
     * refusal that failed closed became a lie that failed slowly.
     */
    actor: AgentActor;
    botId: string;
  }): Promise<AbstractAgent | null> => {
    const { actor } = input;
    const agents = await resolveRuntimeAgents(
      () => loadAgents(actor),
      model,
      resolveModelApiKey,
      stallGuard,
      loadToolsForActor?.(actor.id),
      signRunForActor?.(actor.id),
      config.computer ? COMPUTER_GUIDANCE : undefined,
      loadVendors,
      selectionForActor?.(actor.id),
      agentFetch,
      handoffForActor?.(actor.id),
      // Only the Bot this hop is for. The roster is still read in full, so a Bot this person cannot
      // see is still absent; what this skips is constructing the other Bots and asking the database
      // what each of them was granted, on every delivery and again on every retry.
      input.botId,
      config.agentStallTimeoutMs,
    );
    return agents[input.botId] ?? null;
  };

  /*
   * One client, used by the runtime and by anything reading a thread beside it, so a hop reads the
   * history a person's run would read rather than a second view of it that could disagree.
   */
  const intelligenceClient = new IntelligenceKnowingANewThread({
    apiUrl: intelligence.apiUrl,
    wsUrl: intelligence.gatewayWsUrl,
    apiKey: intelligence.apiKey,
  });

  const runtime = new CopilotRuntime({
    // `mode` is inferred from the presence of `intelligence`; passing it is a type error.
    //
    // identifyUser is NOT optional in practice. Threads and memory are scoped to the user it
    // returns, so omitting it puts every person in the deployment in the same thread space and one
    // person's conversations become another's.
    identifyUser,
    // The subclass, not the base: a thread nobody has run yet reads as empty rather than as a 500.
    // See IntelligenceKnowingANewThread.
    intelligence: intelligenceClient,
    licenseToken: intelligence.licenseToken,
    // Carried on the events the runtime already sends, so OpenBot's traffic is separable from any
    // other deployment's. Adds no events of its own.
    ...(config.accessibility
      ? { telemetryProperties: { accessibility_title: "OpenBot" } }
      : {}),
    /*
     * What lets a Bot answer with an interface it wrote itself.
     *
     * This one flag is the whole difference between a Bot that draws and a Bot that describes
     * markup it cannot show. The middleware it turns on does not give the model the tool — the
     * browser does that — it reads the arguments of the `generateSandboxedUi` call as they stream
     * and re-emits them as `open-generative-ui` activity events. Those events are the only thing
     * that paints: the tool's own renderer shows the waiting message and then returns nothing. So a
     * deployment with the browser half and not this one has Bots generating whole interfaces that
     * never appear, which is the shape this capability arrived in.
     *
     * `true` rather than a list of Bots. The list narrows only the event transform, and the tool
     * stays offered to every Bot regardless, so naming some Bots here would leave the others able to
     * call it and draw nothing. Whether the capability exists at all is the switch this deployment
     * has; see DeploymentConfig.generativeUi.
     */
    ...(config.generativeUi ? { openGenerativeUI: true } : {}),
    // `identifyUser` is the Intelligence projection of the same person `identifyActor` returns:
    // one resolver decides both whose threads these are and whose coworkers exist.
    agents: createRequestAgents(
      identifyActor,
      loadAgents,
      model,
      resolveModelApiKey,
      stallGuard,
      loadToolsForActor,
      signRunForActor,
      /*
       * Only when a computer exists. The tools themselves are registered by the surface, so a Bot is
       * offered them without this and the guidance is what tells it how they go together: snapshot
       * before acting, and ask a person to take the wheel at a sign-in rather than reporting the task
       * as impossible. Absent computer, absent guidance: a Bot is not told about hands it has not got.
       */
      config.computer ? COMPUTER_GUIDANCE : undefined,
      loadVendors,
      selectionForActor,
      agentFetch,
      handoffForActor,
      config.agentStallTimeoutMs,
    ) as never,
  });

  return {
    handler: createCopilotHonoHandler({ runtime, basePath }),
    /**
     * How to reach the platform's runner, exactly as the runtime reaches it.
     *
     * TAKEN FROM THE CLIENT, NOT FROM CONFIGURATION, and this is the whole of a bug that only a real
     * gateway could show. Built from `gatewayWsUrl` and the deployment's API key, every join was
     * refused with `active_lock_mismatch`: a thread's active run is a lock the platform issues, and
     * the token that holds it is not the API key. The runtime asks the client for both, so anything
     * else driving a run has to ask the same client the same way.
     */
    runnerConnection: () => ({
      url: intelligenceClient.ɵgetRunnerWsUrl(),
      authToken: intelligenceClient.ɵgetRunnerAuthToken(),
    }),
    /**
     * The conversation's run lock, as the platform issues it.
     *
     * ONE RUN AT A TIME PER CONVERSATION. Taken before anything is streamed, because the gateway
     * checks every event against the run the lock names: a run that skips this is claiming to be one
     * nobody was told about, and every event is refused. That refusal reads like a platform
     * limitation and is a missing step.
     *
     * A conversation somebody else is already running in refuses rather than queues, which is right:
     * the caller waits and tries again rather than two Bots writing over each other.
     */
    threadLock: {
      acquire: async (input: {
        threadId: string;
        runId: string;
        userId: string;
        agentId: string;
      }) => {
        try {
          const held = await intelligenceClient.ɵacquireThreadLock(input);
          // A run started on this thread. Side effect only, never awaited: a channel showing it is
          // working is worth nothing next to the lock the run depends on.
          try {
            onRunBusy?.({ threadId: input.threadId, busy: true });
          } catch {}
          /*
           * The run id only. The lock also hands back a join token, which is what a browser presents
           * to watch the conversation; the runner's socket has its own credential and passing this
           * one in place of it means a socket that is refused and a run that never starts. See the
           * note on `runner.run` in handoff-delivery.ts.
           */
          return { runId: held.runId };
        } catch (error) {
          /*
           * ONLY A CONFLICT MEANS "NOT NOW". Everything else is raised.
           *
           * A conversation somebody is already running in answers 409, and that is ordinary: the hop
           * waits and is tried again. Anything else is not — a platform that cannot be reached, a
           * token that stopped working, or one of the underscored APIs below being renamed by a
           * routine version bump. Returned as `null` those all read as contention: every hop retries
           * to exhaustion, every person is told their question was never answered, and the only
           * evidence is a warning line that looks like a busy conversation.
           *
           * Raised, the runner writes the real reason onto `agent.handoff_failed`, and the sentence
           * the person eventually gets names it.
           */
          const status =
            error instanceof Error && "status" in error
              ? (error as { status?: unknown }).status
              : undefined;
          if (status === 409) return null;
          throw error;
        }
      },
      renew: async (input: { threadId: string; runId: string }) => {
        await intelligenceClient.ɵrenewThreadLock({
          ...input,
          ttlSeconds: THREAD_LOCK_TTL_SECONDS,
        });
      },
      release: async (input: { threadId: string; runId: string }) => {
        // The run on this thread is over. Cleared here rather than trusting a browser: the run may
        // have outlived the tab that started it, and this is where the platform is told it ended.
        try {
          onRunBusy?.({ threadId: input.threadId, busy: false });
        } catch {}
        await intelligenceClient.ɵcleanupThreadLock(input);
      },
    },
    agentFor,
    /**
     * A thread's messages, as the platform holds them.
     *
     * The same client the runtime uses, so a hop reads the history a person's run would read rather
     * than a second view of it that could disagree.
     */
    history: async (input: { threadId: string; actorId: string }) => {
      /*
       * The platform's own message type rather than AG-UI's, inferred rather than named: the two are
       * compatible where it matters and naming the wrong one here would mean converting a history
       * that does not need converting.
       */
      type Read = Awaited<
        ReturnType<CopilotKitIntelligence["getThreadMessages"]>
      >;
      const read = await historyOrEmpty<Read>(
        () =>
          intelligenceClient.getThreadMessages({
            threadId: input.threadId,
            userId: input.actorId,
          }),
        { messages: [] } as Read,
      );
      return read.messages;
    },
  };
}
