import { describe, expect, test } from "bun:test";
import { EventType } from "@ag-ui/core";
import { toolCallResultEvent } from "./tool-events";

describe("Codex adapter tool-result events", () => {
  test("binds retrieved content to the exact AG-UI tool call", () => {
    expect(
      toolCallResultEvent(
        "fetch-7",
        '{"finalUrl":"https://official.example/source"}',
      ),
    ).toEqual({
      type: EventType.TOOL_CALL_RESULT,
      messageId: "tool-result:fetch-7",
      toolCallId: "fetch-7",
      content: '{"finalUrl":"https://official.example/source"}',
      role: "tool",
    });
  });
});
