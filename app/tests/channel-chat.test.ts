import { expect, test } from "bun:test";
import { startBackgroundTurn } from "../src/components/channels/channel-chat";

test("a rejected seed or component-button turn is handled at its fire-and-forget boundary", async () => {
  const failure = new Error("runtime unavailable");
  let handled: unknown;

  startBackgroundTurn(Promise.reject(failure), (error) => {
    handled = error;
  });
  await Promise.resolve();

  expect(handled).toBe(failure);
});
