import { describe, expect, test } from "bun:test";
import { compactMessages } from "../src/agents/context-compaction";

describe("long-thread context compaction", () => {
  const messages = [
    {
      id: "rules",
      role: "system",
      content: "Approved invariant: never invent totals.",
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      id: `m${index}`,
      role: index % 2 ? "assistant" : "user",
      content: `turn-${index}-${"x".repeat(40)}`,
    })),
  ];

  test("preserves system invariants, marks compaction, and keeps the recent tail", () => {
    const result = compactMessages(messages, {
      thresholdCharacters: 100,
      retainRecent: 3,
    });
    expect(result.compacted).toBe(true);
    expect(result.omittedMessages).toBe(5);
    expect(result.messages[0]).toEqual(messages[0]);
    expect(String(result.messages[1]?.content)).toContain(
      "OpenBot context compaction",
    );
    expect(String(result.messages[1]?.content)).toContain(
      result.capsuleChecksum,
    );
    expect(result.messages.slice(-3)).toEqual(messages.slice(-3));
  });

  test("the capsule changes when omitted context changes", () => {
    const first = compactMessages(messages, {
      thresholdCharacters: 1,
      retainRecent: 2,
    });
    const changed = structuredClone(messages);
    changed[1]!.content = "a different old fact";
    const second = compactMessages(changed, {
      thresholdCharacters: 1,
      retainRecent: 2,
    });
    expect(second.capsuleChecksum).not.toBe(first.capsuleChecksum);
  });

  test("leaves a short thread untouched", () => {
    const result = compactMessages(messages.slice(0, 2), {
      thresholdCharacters: 10_000,
    });
    expect(result.compacted).toBe(false);
    expect(result.messages).toEqual(messages.slice(0, 2));
  });

  test("accepts restored tool messages whose content is undefined", () => {
    const restored = [
      { id: "system", role: "system", content: "invariant" },
      { id: "tool", role: "tool", content: undefined },
      { id: "user", role: "user", content: "continue" },
    ];
    expect(() =>
      compactMessages(restored, { thresholdCharacters: 1, retainRecent: 1 }),
    ).not.toThrow();
  });

  test("never retains a tool result without its assistant tool call", () => {
    const paired = [
      { id: "system", role: "system", content: "invariant" },
      { id: "old", role: "user", content: "x".repeat(100) },
      {
        id: "call",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1" }],
      },
      { id: "result", role: "tool", toolCallId: "call-1", content: "found" },
      { id: "latest", role: "user", content: "continue" },
    ];
    const result = compactMessages(paired, {
      thresholdCharacters: 1,
      retainRecent: 2,
    });
    expect(result.messages.map((message) => message.id)).toContain("call");
    expect(result.messages.map((message) => message.id)).toContain("result");
  });
});
