import { describe, expect, test } from "bun:test";
import { createTerminalAnalyticsQueue } from "./terminal-queue";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

const turn = {
  id: "channel:one:turn:killed",
  agentId: "general-assistant",
  threadId: "thread-one",
  startedAt: "2026-09-01T17:00:00.000Z",
  promptLength: 12,
};

describe("durable terminal analytics", () => {
  test("keeps failed requests and retries them in order", async () => {
    const storage = memoryStorage();
    let online = false;
    const calls: string[] = [];
    const queue = createTerminalAnalyticsQueue(storage, (async (path) => {
      calls.push(String(path));
      if (!online) throw new TypeError("offline");
      return new Response(null, { status: 204 });
    }) as typeof fetch);
    queue.enqueue({
      id: "finish",
      path: "/finish",
      body: { ok: true },
      createdAt: "now",
    });
    queue.enqueue({ id: "verify", path: "/verify", createdAt: "now" });

    expect(await queue.flush()).toBe(2);
    online = true;
    expect(await queue.flush()).toBe(0);
    expect(calls).toEqual(["/finish", "/finish", "/verify"]);
  });

  test("turns a page-hidden active turn into an idempotent abandoned terminal event", async () => {
    const storage = memoryStorage();
    const bodies: unknown[] = [];
    const queue = createTerminalAnalyticsQueue(storage, (async (
      _path,
      init,
    ) => {
      bodies.push(JSON.parse(String(init?.body)));
      expect(init?.keepalive).toBe(true);
      return new Response(null, { status: 204 });
    }) as typeof fetch);
    queue.remember(turn);
    queue.abandonActive(new Date("2026-09-01T17:00:04.000Z"));

    expect(await queue.flush(true)).toBe(0);
    expect(bodies[0]).toMatchObject({
      session: {
        id: turn.id,
        status: "abandoned",
        endedAt: "2026-09-01T17:00:04.000Z",
      },
      events: [{ idempotencyKey: `${turn.id}:abandoned`, latencyMs: 4000 }],
    });
  });
});
