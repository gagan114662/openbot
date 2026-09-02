import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  fetchTurnEvaluation,
  humanGateTools,
  latestEvaluableTurnSessionId,
  observedTools,
  turnFinishPayload,
  turnStartPayload,
} from "./turns";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const turn = {
  id: "channel:one:turn:two",
  agentId: "general-assistant",
  threadId: "thread-one",
  startedAt: "2026-09-01T17:00:00.000Z",
  promptLength: 41,
};

describe("native channel analytics", () => {
  test("treats a missing evaluation as an ordinary unevaluated answer", async () => {
    globalThis.fetch = mock(
      async () => new Response(null, { status: 404 }),
    ) as unknown as typeof fetch;
    expect(await fetchTurnEvaluation("missing")).toBeNull();
  });

  test("does not disguise a failed evaluation lookup as a missing verdict", async () => {
    globalThis.fetch = mock(
      async () => new Response(null, { status: 503 }),
    ) as unknown as typeof fetch;
    expect(fetchTurnEvaluation("offline")).rejects.toThrow(
      "Could not restore the answer evaluation.",
    );
  });
  test("recovers the latest answer's session id from durable messages", () => {
    expect(
      latestEvaluableTurnSessionId(
        [
          { id: "user-old", role: "user", content: "old" },
          { id: "answer-old", role: "assistant", content: "old answer" },
          { id: "user-latest", role: "user", content: "latest" },
          { id: "tool", role: "tool", toolCallId: "call", content: "data" },
          { id: "answer", role: "assistant", content: "answer" },
        ],
        "channel-7",
      ),
    ).toBe("channel:channel-7:turn:user-latest");
  });

  test("records a content-free, idempotent start", () => {
    const payload = turnStartPayload(turn);
    expect(payload.session).toMatchObject({
      privacyMode: "metadata_only",
      status: "running",
      properties: { promptLength: 41 },
    });
    expect(payload.events[0]?.idempotencyKey).toBe(
      "channel:one:turn:two:started",
    );
    expect(JSON.stringify(payload)).not.toContain("content");
  });

  test("separates technical completion from task correctness", () => {
    const payload = turnFinishPayload(
      turn,
      { status: "completed", latencyMs: 912, responseLength: 14 },
      "2026-09-01T17:00:00.912Z",
    );
    expect(payload.session.status).toBe("completed");
    expect(payload.session).not.toHaveProperty("taskCompleted");
    expect(payload.events[0]).toMatchObject({
      eventType: "agent.turn.completed",
      success: true,
      latencyMs: 912,
      properties: { responseLength: 14 },
    });
  });

  test("marks thrown runs as technical failures", () => {
    const payload = turnFinishPayload(
      turn,
      {
        status: "failed",
        latencyMs: 101,
        responseLength: 0,
        errorType: "TypeError",
      },
      "2026-09-01T17:00:00.101Z",
    );
    expect(payload.session.technicalFailure).toBe(true);
    expect(payload.events[0]).toMatchObject({
      eventType: "agent.turn.failed",
      success: false,
      errorType: "TypeError",
    });
  });

  test("records tool identity and result presence without arguments or results", () => {
    const tools = observedTools(
      [
        { id: "old", role: "user", content: "before" },
        {
          id: "assistant",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "mcp__open-web__fetch_web_page",
                arguments: '{"url":"https://example.com","secret":"no"}',
              },
            },
          ],
        },
        {
          id: "result",
          role: "tool",
          toolCallId: "call-1",
          content: "private page contents",
        },
      ],
      new Set(["old"]),
    );
    expect(tools).toEqual([
      {
        id: "call-1",
        name: "mcp__open-web__fetch_web_page",
        resultObserved: true,
      },
    ]);
    const payload = turnFinishPayload(
      turn,
      {
        status: "completed",
        latencyMs: 500,
        responseLength: 14,
        tools,
        model: "gpt-5.6-sol",
        inputTokens: 120,
        cachedInputTokens: 80,
        outputTokens: 14,
        reasoningOutputTokens: 3,
        totalTokens: 134,
      },
      "2026-09-01T17:00:00.500Z",
    );
    expect(payload.events[1]).toMatchObject({
      eventType: "agent.tool.observed",
      name: "mcp__open-web__fetch_web_page",
    });
    expect(payload.events[1]).not.toHaveProperty("success");
    expect(payload.session.model).toBe("gpt-5.6-sol");
    expect(payload.events[0]).toMatchObject({
      model: "gpt-5.6-sol",
      inputTokens: 120,
      outputTokens: 14,
      properties: {
        cachedInputTokens: 80,
        reasoningOutputTokens: 3,
        totalTokens: 134,
      },
    });
    expect(JSON.stringify(payload)).not.toContain("private page contents");
    expect(JSON.stringify(payload)).not.toContain("secret");
  });

  test("records human gates without their question or options", () => {
    const tools = [
      { id: "choice-1", name: "askChoice", resultObserved: false },
    ];
    expect(humanGateTools(tools)).toEqual(tools);
    const payload = turnFinishPayload(
      turn,
      {
        status: "completed",
        latencyMs: 10,
        responseLength: 0,
        tools,
        humanWaitMs: 4,
      },
      "2026-09-01T17:00:00.010Z",
    );
    expect(payload.events).toContainEqual(
      expect.objectContaining({
        eventType: "agent.human_intervention.requested",
        properties: { mechanism: "askChoice" },
      }),
    );
    expect(payload.events[0]?.properties).toMatchObject({ humanWaitMs: 4 });
    expect(JSON.stringify(payload)).not.toContain("Which policy");
  });
});
