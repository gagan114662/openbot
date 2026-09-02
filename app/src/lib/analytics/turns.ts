import type { Message } from "@ag-ui/core";
import { client, tryClient } from "@/lib/client";
import { terminalAnalyticsQueue } from "./terminal-queue";

export type TurnAnalytics = {
  id: string;
  agentId: string;
  threadId: string;
  startedAt: string;
  promptLength: number;
};

type TurnOutcome = {
  status: "completed" | "failed";
  latencyMs: number;
  responseLength: number;
  errorType?: string;
  tools?: ObservedTool[];
  model?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  humanWaitMs?: number;
};

export type ObservedTool = {
  id: string;
  name: string;
  resultObserved: boolean;
};

export function humanGateTools(tools: readonly ObservedTool[]): ObservedTool[] {
  return tools.filter(
    (tool) =>
      tool.name === "askChoice" ||
      tool.name === "askApproval" ||
      tool.name === "ask_person",
  );
}

/** Extract tool identity and completion only; arguments and results never enter analytics. */
export function observedTools(
  messages: readonly Message[],
  messageIdsBeforeTurn: ReadonlySet<string>,
): ObservedTool[] {
  const current = messages.filter(
    (message) => !messageIdsBeforeTurn.has(message.id),
  );
  const results = new Set(
    current.flatMap((message) =>
      message.role === "tool" && "toolCallId" in message
        ? [String(message.toolCallId)]
        : [],
    ),
  );
  return current.flatMap((message) =>
    message.role === "assistant"
      ? (message.toolCalls ?? []).map((call) => ({
          id: call.id,
          name: call.function.name,
          resultObserved: results.has(call.id),
        }))
      : [],
  );
}

/**
 * Recover the deterministic analytics id for the latest visible answer after thread restoration.
 * The id is built from the user message that began the turn, so no analytics identifier has to be
 * copied into conversation content or provider-specific message metadata.
 */
export function latestEvaluableTurnSessionId(
  messages: readonly Message[],
  channelId: string,
): string | null {
  const assistantIndex = messages.findLastIndex(
    (message) =>
      message.role === "assistant" &&
      (typeof message.content !== "string" ||
        message.content.trim().length > 0),
  );
  if (assistantIndex < 0) return null;
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      return `channel:${channelId}:turn:${message.id}`;
    }
  }
  return null;
}

export function turnStartPayload(turn: TurnAnalytics) {
  return {
    session: {
      id: turn.id,
      agentId: turn.agentId,
      source: "openbot-channel",
      privacyMode: "metadata_only" as const,
      status: "running" as const,
      startedAt: turn.startedAt,
      properties: {
        promptLength: turn.promptLength,
        threadId: turn.threadId,
      },
    },
    events: [
      {
        idempotencyKey: `${turn.id}:started`,
        eventType: "agent.turn.started",
        name: "Channel turn started",
        success: true,
        occurredAt: turn.startedAt,
        properties: { promptLength: turn.promptLength },
      },
    ],
  };
}

export function turnFinishPayload(
  turn: TurnAnalytics,
  outcome: TurnOutcome,
  endedAt = new Date().toISOString(),
) {
  const tools = outcome.tools ?? [];
  return {
    session: {
      id: turn.id,
      agentId: turn.agentId,
      source: "openbot-channel",
      privacyMode: "metadata_only" as const,
      status: outcome.status,
      technicalFailure: outcome.status === "failed",
      model: outcome.model,
      startedAt: turn.startedAt,
      endedAt,
    },
    events: [
      {
        idempotencyKey: `${turn.id}:finished`,
        eventType:
          outcome.status === "completed"
            ? "agent.turn.completed"
            : "agent.turn.failed",
        name:
          outcome.status === "completed"
            ? "Channel turn completed"
            : "Channel turn failed",
        success: outcome.status === "completed",
        errorType: outcome.errorType,
        model: outcome.model,
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
        latencyMs: outcome.latencyMs,
        occurredAt: endedAt,
        properties: {
          responseLength: outcome.responseLength,
          toolCalls: tools.length,
          cachedInputTokens: outcome.cachedInputTokens,
          reasoningOutputTokens: outcome.reasoningOutputTokens,
          totalTokens: outcome.totalTokens,
          humanWaitMs: outcome.humanWaitMs,
        },
      },
      ...tools.map((tool) => ({
        idempotencyKey: `${turn.id}:tool:${tool.id}`,
        eventType: "agent.tool.observed",
        name: tool.name,
        occurredAt: endedAt,
        properties: {
          toolCallId: tool.id,
          resultObserved: tool.resultObserved,
          executionSurface: "channel-client",
        },
      })),
      ...humanGateTools(tools).map((tool) => ({
        idempotencyKey: `${turn.id}:human-gate:${tool.id}`,
        eventType: "agent.human_intervention.requested",
        name: "Human decision requested",
        occurredAt: endedAt,
        properties: { mechanism: tool.name },
      })),
    ],
  };
}

/** Record a suspended human gate immediately; waiting for the run to finish can take hours. */
export async function recordHumanGate(
  turn: TurnAnalytics,
  tool: ObservedTool,
): Promise<void> {
  await client("/api/analytics/ingest", {
    method: "POST",
    fallback: "Could not record the human decision gate.",
    body: {
      session: {
        id: turn.id,
        agentId: turn.agentId,
        source: "openbot-channel",
        privacyMode: "metadata_only",
        status: "running",
        startedAt: turn.startedAt,
      },
      events: [
        {
          idempotencyKey: `${turn.id}:human-gate:${tool.id}`,
          eventType: "agent.human_intervention.requested",
          name: "Human decision requested",
          occurredAt: new Date().toISOString(),
          properties: { mechanism: tool.name },
        },
      ],
    },
  });
}

/**
 * Native channel instrumentation.
 *
 * Content is deliberately not sent: metadata-only is the safe deployment default. The stable
 * session id still joins this turn to its events, while lengths, timing, status, and agent identity
 * make missing replies and regressions measurable without copying a conversation into analytics.
 */
export async function beginTurnAnalytics(turn: TurnAnalytics): Promise<void> {
  terminalAnalyticsQueue()?.remember(turn);
  await client("/api/analytics/ingest", {
    method: "POST",
    fallback: "Could not begin the analytics trace.",
    body: turnStartPayload(turn),
  });
}

export async function finishTurnAnalytics(
  turn: TurnAnalytics,
  outcome: TurnOutcome,
): Promise<void> {
  const queue = terminalAnalyticsQueue();
  if (!queue) return;
  const createdAt = new Date().toISOString();
  queue.enqueue({
    id: `${turn.id}:finish`,
    path: "/api/analytics/ingest",
    body: turnFinishPayload(turn, outcome, createdAt),
    createdAt,
  });
  queue.enqueue({
    id: `${turn.id}:verify-tools`,
    path: `/api/analytics/sessions/${encodeURIComponent(turn.id)}/verify-tools`,
    createdAt,
  });
  queue.enqueue({
    id: `${turn.id}:verify-escalation`,
    path: `/api/analytics/sessions/${encodeURIComponent(turn.id)}/verify-escalation`,
    createdAt,
  });
  queue.forget(turn.id);
  await queue.flush();
}

/** Attach a human correctness verdict to the exact turn that produced the visible answer. */
export async function evaluateTurnAnalytics(
  sessionId: string,
  taskCompleted: boolean,
): Promise<void> {
  await client(
    `/api/analytics/sessions/${encodeURIComponent(sessionId)}/feedback`,
    {
      method: "POST",
      fallback: "Could not save the answer evaluation.",
      body: {
        taskCompleted,
        rating: taskCompleted ? 5 : 1,
        negative: !taskCompleted,
        category: "answer_correctness",
      },
    },
  );
}

/** Restore whether the latest durable answer still needs a verdict. */
export async function fetchTurnEvaluation(sessionId: string): Promise<{
  status: string;
  taskCompleted: boolean | null;
} | null> {
  const response = await tryClient(
    `/api/analytics/sessions/${encodeURIComponent(sessionId)}/evaluation`,
    { fallback: "Could not restore the answer evaluation." },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Could not restore the answer evaluation.");
  const body = (await response.json()) as {
    evaluation: { status: string; taskCompleted: boolean | null };
  };
  return body.evaluation;
}
