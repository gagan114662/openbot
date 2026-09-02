const QUEUE_KEY = "openbot.analytics-terminal-queue.v1";
const ACTIVE_KEY = "openbot.analytics-active-turns.v1";
const MAX_QUEUED_REQUESTS = 300;

type StorageLike = Pick<Storage, "getItem" | "setItem">;
type QueuedRequest = {
  id: string;
  path: string;
  body?: unknown;
  createdAt: string;
};

/** Kept structural here so the durable queue does not import the module that consumes it. */
type ActiveTurn = {
  id: string;
  agentId: string;
  threadId: string;
  startedAt: string;
  promptLength: number;
};

function read<T>(storage: StorageLike, key: string, fallback: T): T {
  try {
    return JSON.parse(storage.getItem(key) ?? "") as T;
  } catch {
    return fallback;
  }
}

function write(storage: StorageLike, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Analytics must never break the conversation when storage is unavailable or full.
  }
}

export function createTerminalAnalyticsQueue(
  storage: StorageLike,
  request: typeof fetch,
) {
  const queued = () => read<QueuedRequest[]>(storage, QUEUE_KEY, []);

  function enqueue(item: QueuedRequest): void {
    const next = queued().filter((candidate) => candidate.id !== item.id);
    next.push(item);
    write(storage, QUEUE_KEY, next.slice(-MAX_QUEUED_REQUESTS));
  }

  function remember(turn: ActiveTurn): void {
    const active = read<ActiveTurn[]>(storage, ACTIVE_KEY, []).filter(
      (candidate) => candidate.id !== turn.id,
    );
    active.push(turn);
    write(storage, ACTIVE_KEY, active);
  }

  function forget(id: string): void {
    write(
      storage,
      ACTIVE_KEY,
      read<ActiveTurn[]>(storage, ACTIVE_KEY, []).filter(
        (turn) => turn.id !== id,
      ),
    );
  }

  function abandonActive(now = new Date()): void {
    for (const turn of read<ActiveTurn[]>(storage, ACTIVE_KEY, [])) {
      const endedAt = now.toISOString();
      enqueue({
        id: `${turn.id}:abandoned`,
        path: "/api/analytics/ingest",
        createdAt: endedAt,
        body: {
          session: {
            id: turn.id,
            agentId: turn.agentId,
            source: "openbot-channel",
            privacyMode: "metadata_only",
            status: "abandoned",
            technicalFailure: true,
            startedAt: turn.startedAt,
            endedAt,
          },
          events: [
            {
              idempotencyKey: `${turn.id}:abandoned`,
              eventType: "agent.turn.abandoned",
              name: "Channel turn abandoned",
              success: false,
              errorType: "browser_terminated",
              latencyMs: Math.max(
                0,
                now.getTime() - new Date(turn.startedAt).getTime(),
              ),
              occurredAt: endedAt,
            },
          ],
        },
      });
    }
    write(storage, ACTIVE_KEY, []);
  }

  async function flush(keepalive = false): Promise<number> {
    let pending = queued();
    for (const item of pending) {
      try {
        const response = await request(item.path, {
          method: "POST",
          credentials: "include",
          headers:
            item.body === undefined
              ? undefined
              : { "content-type": "application/json" },
          body: item.body === undefined ? undefined : JSON.stringify(item.body),
          keepalive,
        });
        if (!response.ok) break;
        pending = pending.filter((candidate) => candidate.id !== item.id);
        write(storage, QUEUE_KEY, pending);
      } catch {
        break;
      }
    }
    return pending.length;
  }

  return { enqueue, remember, forget, abandonActive, flush, queued };
}

let browserQueue: ReturnType<typeof createTerminalAnalyticsQueue> | undefined;

export function terminalAnalyticsQueue() {
  if (typeof window === "undefined") return undefined;
  browserQueue ??= createTerminalAnalyticsQueue(
    window.localStorage,
    window.fetch.bind(window),
  );
  return browserQueue;
}

if (typeof window !== "undefined") {
  window.addEventListener(
    "online",
    () => void terminalAnalyticsQueue()?.flush(),
  );
  window.addEventListener("pagehide", () => {
    terminalAnalyticsQueue()?.abandonActive();
    void terminalAnalyticsQueue()?.flush(true);
  });
  queueMicrotask(() => void terminalAnalyticsQueue()?.flush());
}
