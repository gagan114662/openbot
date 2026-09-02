import type { RunAgentInput } from "@ag-ui/client";
import type { ShadowEvaluator } from "./shadow-evaluator";

export function createInferenceShadowRecorder(options: {
  evaluator: Pick<ShadowEvaluator, "shouldEvaluate" | "record">;
  primaryModel: string;
  shadowModel: string;
  rateBasisPoints: number;
  resolveApiKey: () => Promise<string | null>;
  endpoint: string;
  fetch?: typeof fetch;
}) {
  return async (input: { run: RunAgentInput; primaryOutput: string }) => {
    if (
      !options.evaluator.shouldEvaluate(
        input.run.runId,
        options.rateBasisPoints,
      )
    )
      return;
    const key = await options.resolveApiKey();
    if (!key) throw new Error("Shadow inference has no model credential.");
    const started = performance.now();
    const response = await (options.fetch ?? fetch)(options.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: options.shadowModel,
        messages: input.run.messages.flatMap((message) =>
          typeof message.content === "string"
            ? [{ role: message.role, content: message.content }]
            : [],
        ),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok)
      throw new Error(`Shadow model answered ${response.status}.`);
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const shadowOutput = body.choices?.[0]?.message?.content;
    if (typeof shadowOutput !== "string")
      throw new Error("Shadow model returned no text.");
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
