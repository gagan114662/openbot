import { useRenderTool } from "@copilotkit/react-core/v2";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { HANDED_OVER } from "@/lib/copilot/markers";
import { UNANSWERED_TOOL_RESULT } from "@/lib/copilot/repair-history";
import { visibleToolHistoryResult } from "@/lib/copilot/tool-history-result";
import { asText, saidItWentAhead } from "@/lib/plugins/tool-result";

/**
 * How a Bot handing work to another Bot reads in the transcript.
 *
 * RENDER ONLY. `message_bot` runs on the server, where the grant, the caps and the audit row are, so
 * nothing here registers a tool or decides anything. What it registers is a line, because a hop that
 * happens off-screen is the thing the issue asks to avoid: a conversation that quietly fans out to
 * four Bots and bills for all of them should say so while it is doing it.
 *
 * Without this the call still appears, as a generic tool call named `message_bot` with its arguments
 * as JSON. That is technically visible and practically not: the point is that a person can see their
 * Bot bringing in another one and read what it asked for.
 */
const parameters = z.object({
  bot: z.string().optional(),
  task: z.string().optional(),
  constraints: z.string().optional(),
  expecting: z.string().optional(),
});

/**
 * Whether the deployment refused the hop.
 *
 * The result is a sentence the Bot can say either way, because a refusal mid-run is an answer rather
 * than an exception. The transcript still has to tell the two apart: one is a Bot bringing in help,
 * the other is a boundary holding, and drawing them the same way would make a working cap look like
 * a working handoff.
 */
export function handoffOutcome(
  result: unknown,
): "accepted" | "refused" | "unknown" {
  // Restored AG-UI history may preserve the call but not its result, represented as an empty
  // string. Empty proves neither success nor refusal and must not turn a delivered historical hop
  // into a red “Blocked” card.
  if (
    typeof result !== "string" ||
    asText(result).trim() === "" ||
    asText(result).trim() === UNANSWERED_TOOL_RESULT
  )
    return "unknown";
  return saidItWentAhead(result, HANDED_OVER) ? "accepted" : "refused";
}

/**
 * The authoritative recipient name returned by the server for an accepted hop.
 *
 * The tool argument is model-authored and intentionally uses a stable routing id. Echoing it made
 * `knowledge` leak into a human-facing line, and would also let a stale/fabricated argument label a
 * successful hop. The desk resolves the profile and returns its current display name, so that is
 * the source the transcript should trust.
 */
export function handedToName(result: unknown): string | undefined {
  if (typeof result !== "string") return undefined;
  const text = asText(result);
  if (!text.startsWith(HANDED_OVER)) return undefined;
  const suffix = ". Its answer will be relayed";
  const end = text.indexOf(suffix, HANDED_OVER.length);
  if (end < 0) return undefined;
  const name = text.slice(HANDED_OVER.length, end).trim();
  return name || undefined;
}

/**
 * What belongs in the expanded handoff card.
 *
 * Restored AG-UI history often keeps the call but not its immediate tool result, and the generic
 * history repair supplies `UNANSWERED_TOOL_RESULT` so the protocol remains well formed. That text
 * is useful for an ordinary synchronous tool and false for this asynchronous one: acceptance queues
 * the work, and success or terminal failure returns later as a Bot-authored message. Showing “do not
 * assume it succeeded” directly above the returned answer makes a successful handoff contradict
 * itself. Absence stays neutral; real accepted results and real refusal sentences remain visible.
 */
export function handoffResultDetail(result: unknown): string | undefined {
  return visibleToolHistoryResult(result);
}

export function HandoffTool() {
  useRenderTool({
    name: "message_bot",
    parameters,
    render: ({ parameters: given, result, status }) => {
      const asked = given?.bot?.trim();
      const running = status !== "complete" && result === undefined;
      const outcome = handoffOutcome(result);
      const acceptedName =
        outcome === "accepted" ? handedToName(result) : undefined;
      const resultDetail = handoffResultDetail(result);
      const label =
        outcome === "unknown"
          ? asked
            ? `Requested ${asked}`
            : "Requested another Bot"
          : acceptedName || asked
            ? `Asked ${acceptedName ?? asked}`
            : "Asked another Bot";
      return (
        <ToolLine
          label={label}
          detail={given?.task}
          running={running}
          refused={!running && outcome === "refused"}
        >
          {/*
           * The parts, kept as parts. The asking model was made to name them so the receiving one
           * need not infer them, and a person reading the conversation gets the same benefit: what
           * was asked, what bounded it, and what was wanted back.
           */}
          <div className="space-y-1 text-sm">
            {given?.task ? <p>{given.task}</p> : null}
            {given?.constraints ? (
              <p className="text-muted-foreground">
                Constraints: {given.constraints}
              </p>
            ) : null}
            {given?.expecting ? (
              <p className="text-muted-foreground">
                Wanted back: {given.expecting}
              </p>
            ) : null}
            {resultDetail ? (
              <p className="text-muted-foreground">{resultDetail}</p>
            ) : null}
          </div>
        </ToolLine>
      );
    },
  });

  return null;
}
