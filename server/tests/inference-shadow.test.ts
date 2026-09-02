import { describe, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/client";
import { createInferenceShadowRecorder } from "../src/software-factory/inference-shadow";

describe("real inference shadow path", () => {
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
});
