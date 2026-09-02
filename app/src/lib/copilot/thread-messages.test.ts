import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { mergeStoredMessages } from "./thread-messages";

const message = (id: string, content = id): Message => ({
  id,
  role: "user",
  content,
});

describe("merging durable thread history", () => {
  test("restores the full history when connectAgent already supplied its first message", () => {
    const stored = [message("first"), message("reply"), message("latest")];
    expect(mergeStoredMessages(stored, [message("first")])).toEqual(stored);
  });

  test("keeps a genuinely new local message after durable history", () => {
    expect(
      mergeStoredMessages(
        [message("first"), message("reply")],
        [message("first"), message("typed-during-load")],
      ).map(({ id }) => id),
    ).toEqual(["first", "reply", "typed-during-load"]);
  });

  test("does not replace local state with an empty store response", () => {
    expect(mergeStoredMessages([], [message("local")])).toEqual([
      message("local"),
    ]);
  });

  test("a delayed pull restores durable order ahead of newer local arrivals", () => {
    expect(
      mergeStoredMessages(
        [message("first"), message("delayed-reply")],
        [message("first"), message("newer-local")],
      ).map(({ id }) => id),
    ).toEqual(["first", "delayed-reply", "newer-local"]);
  });
});
