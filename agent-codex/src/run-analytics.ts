type Json = Record<string, unknown>;

export type CodexRunAnalytics = {
  model: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
};

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function modelFromThreadStart(response: Json, fallback: string): string {
  const result = response.result as Json | undefined;
  return typeof result?.model === "string" && result.model.trim()
    ? result.model
    : fallback;
}

/** Parse the documented v2 thread/tokenUsage/updated notification. */
export function usageFromNotification(
  event: Json,
): Omit<CodexRunAnalytics, "model"> | null {
  if (event.method !== "thread/tokenUsage/updated") return null;
  const params = event.params as Json | undefined;
  const tokenUsage = params?.tokenUsage as Json | undefined;
  const last = tokenUsage?.last as Json | undefined;
  if (!last) return null;
  const usage = {
    inputTokens: nonNegativeNumber(last.inputTokens),
    cachedInputTokens: nonNegativeNumber(last.cachedInputTokens),
    outputTokens: nonNegativeNumber(last.outputTokens),
    reasoningOutputTokens: nonNegativeNumber(last.reasoningOutputTokens),
    totalTokens: nonNegativeNumber(last.totalTokens),
  };
  return Object.fromEntries(
    Object.entries(usage).filter(([, value]) => value !== undefined),
  );
}
