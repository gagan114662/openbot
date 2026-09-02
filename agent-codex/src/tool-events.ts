import { type BaseEvent, EventType } from "@ag-ui/core";

/**
 * Carry the deployment tool's actual result back through AG-UI.
 *
 * The Codex adapter previously returned this only to the model process. The OpenBot runtime saw a
 * tool start and end but no result, so it could neither render the evidence nor prove that cited
 * URLs came from retrieval. A stable message id also lets replay repair associate one result with
 * exactly one call.
 */
export function toolCallResultEvent(
  toolCallId: string,
  content: string,
): BaseEvent {
  return {
    type: EventType.TOOL_CALL_RESULT,
    messageId: `tool-result:${toolCallId}`,
    toolCallId,
    content,
    role: "tool",
  } as BaseEvent;
}
