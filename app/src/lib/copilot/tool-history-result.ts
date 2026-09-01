import { asText } from "@/lib/plugins/tool-result";
import { UNANSWERED_TOOL_RESULT } from "./repair-history";

/**
 * A persisted tool result that is honest to show as an outcome.
 *
 * `repairUnansweredToolCalls` inserts a synthetic result when durable AG-UI history lost the real
 * one. Providers require that padding to keep the conversation usable, but it is not an event that
 * happened and must not be drawn as though the server said it. Missing stays neutral; an actual
 * result or refusal remains visible. JSON-string wrapping is removed here for both the comparison
 * and display.
 */
export function visibleToolHistoryResult(result: unknown): string | undefined {
  if (typeof result !== "string") return undefined;
  const text = asText(result).trim();
  if (!text || text === UNANSWERED_TOOL_RESULT) return undefined;
  return text;
}
