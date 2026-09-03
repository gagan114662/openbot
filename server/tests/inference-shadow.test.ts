import { describe, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/client";
import { from, lastValueFrom, toArray } from "rxjs";
import {
  runWithInferenceShadow,
  setInferenceShadowRecorder,
} from "../src/copilot";
import {
  createInferenceShadowRecorder,
  inferenceShadowMetrics,
} from "../src/software-factory/inference-shadow";

describe("inference shadow path wired to the agent stream", () => {
  test("bounds concurrent shadows and drops overflow before spawning", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let invocations = 0;
    const recorder = createInferenceShadowRecorder({
      evaluator: {
        shouldEvaluate: () => true,
        async record() {
          return null;
        },
        async recordFailure() {
          return null;
        },
      },
      primaryModel: "primary",
      shadowModel: "shadow",
      rateBasisPoints: 10_000,
      concurrency: 1,
      queueCapacity: 1,
      async invokeShadow() {
        invocations += 1;
        await held;
        return "shadow";
      },
    });
    const input = (id: string) => ({
      run: {
        runId: id,
        threadId: "thread",
        messages: [],
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
      } as RunAgentInput,
      primaryOutput: "primary",
    });
    const before = inferenceShadowMetrics().dropped;
    const first = recorder(input("first"));
    const second = recorder(input("second"));
    await recorder(input("overflow"));
    expect(invocations).toBe(1);
    expect(inferenceShadowMetrics()).toMatchObject({
      inflight: 1,
      dropped: before + 1,
    });
    release();
    await Promise.all([first, second]);
    expect(invocations).toBe(2);
  });
  test("sends the original model request to a shadow model and derives comparison inputs", async () => {
    const requests: Array<{
      url: string;
      body: unknown;
      authorization: string | null;
    }> = [];
    const records: unknown[] = [];
    const recorder = createInferenceShadowRecorder({
      evaluator: {
        shouldEvaluate: () => true,
        async record(input) {
          records.push(input);
          return null;
        },
        async recordFailure() {
          return null;
        },
      },
      primaryModel: "primary-live",
      shadowModel: "shadow-candidate",
      rateBasisPoints: 500,
      resolveApiKey: async () => "real-path-key",
      endpoint: "https://model-gateway.test/v1/chat/completions",
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return Response.json({
          choices: [
            { message: { content: "shadow answer from the model path" } },
          ],
        });
      },
    });
    const run = {
      runId: "real-run-1",
      threadId: "thread-1",
      messages: [
        { id: "question", role: "user", content: "real user traffic" },
      ],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    } as RunAgentInput;

    await recorder({ run, primaryOutput: "primary answer actually emitted" });

    expect(requests).toEqual([
      {
        url: "https://model-gateway.test/v1/chat/completions",
        authorization: "Bearer real-path-key",
        body: {
          model: "shadow-candidate",
          messages: [{ role: "user", content: "real user traffic" }],
        },
      },
    ]);
    expect(records).toEqual([
      expect.objectContaining({
        requestKey: "real-run-1",
        primaryModel: "primary-live",
        shadowModel: "shadow-candidate",
        primaryOutput: "primary answer actually emitted",
        shadowOutput: "shadow answer from the model path",
      }),
    ]);
  });

  test("can use the Codex subscription invoker without an API credential", async () => {
    const records: unknown[] = [];
    const recorder = createInferenceShadowRecorder({
      evaluator: {
        shouldEvaluate: () => true,
        async record(input) {
          records.push(input);
          return null;
        },
        async recordFailure() {
          return null;
        },
      },
      primaryModel: "primary-live",
      shadowModel: "gpt-5.6-luna",
      rateBasisPoints: 10_000,
      async invokeShadow(messages, signal) {
        expect(signal.aborted).toBe(false);
        expect(messages).toEqual([
          { role: "user", content: "real user traffic" },
        ]);
        return "subscription-backed shadow answer";
      },
    });
    await recorder({
      run: {
        runId: "subscription-shadow-run",
        threadId: "thread-1",
        messages: [
          { id: "question", role: "user", content: "real user traffic" },
        ],
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
      } as RunAgentInput,
      primaryOutput: "primary answer",
    });
    expect(records).toEqual([
      expect.objectContaining({
        requestKey: "subscription-shadow-run",
        shadowOutput: "subscription-backed shadow answer",
      }),
    ]);
  });

  test("a killed shadow cannot alter the completed primary stream", async () => {
    setInferenceShadowRecorder(async () => {
      throw new Error("shadow process was killed");
    });
    const run = {
      runId: "isolated-shadow-failure",
      threadId: "thread-1",
      messages: [],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    } as RunAgentInput;
    const emitted = await lastValueFrom(
      runWithInferenceShadow(run, () =>
        from([
          { type: "TEXT_MESSAGE_CONTENT", delta: "unchanged primary" },
          { type: "RUN_FINISHED" },
        ] as never[]),
      ).pipe(toArray()),
    );
    expect(emitted).toEqual([
      { type: "TEXT_MESSAGE_CONTENT", delta: "unchanged primary" },
      { type: "RUN_FINISHED" },
    ]);
    await Bun.sleep(0);
    setInferenceShadowRecorder(undefined);
  });

  test("persists a failed shadow attempt with primary lineage", async () => {
    const failures: unknown[] = [];
    const recorder = createInferenceShadowRecorder({
      evaluator: {
        shouldEvaluate: () => true,
        async record() {
          throw new Error("successful record must not run");
        },
        async recordFailure(input) {
          failures.push(input);
          return null;
        },
      },
      primaryModel: "primary-live",
      shadowModel: "gpt-5.6-luna",
      rateBasisPoints: 10_000,
      async invokeShadow() {
        throw new Error("shadow deadline exceeded");
      },
    });
    await expect(
      recorder({
        run: {
          runId: "failed-shadow-run",
          threadId: "thread-1",
          messages: [],
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        } as RunAgentInput,
        primaryOutput: "primary still completed",
      }),
    ).rejects.toThrow("shadow deadline exceeded");
    expect(failures).toEqual([
      expect.objectContaining({
        requestKey: "failed-shadow-run",
        primaryOutput: "primary still completed",
        error: "shadow deadline exceeded",
      }),
    ]);
  });
});
