import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createEvolutionCheckpointGate } from "../src/agents/evolution-checkpoints";
import {
  createHandoffRunner,
  type HandoffWork,
} from "../src/agents/handoff-runner";
import { createAuditStore, type AuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { auditEvents, evolutionCheckpoints, workItems } from "../src/db/schema";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL } from "./support/database";

/**
 * Two replicas and one batch of hops, against a real PostgreSQL.
 *
 * A lease is a promise the database keeps about time passing, and every stub of this queue answers
 * whatever it was told to. The whole suite was green while the tail of every batch was delivered
 * twice, because a fake cannot let a lease quietly run out.
 */
const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const queue = createWorkQueue(database);
const kind = `bot.message.test.runner.${randomUUID()}`;

const silent: AuditStore = { insert: async () => {} };

afterAll(async () => {
  await database.delete(workItems).where(eq(workItems.kind, kind));
  await database.$client.close();
});

beforeEach(async () => {
  await database.delete(workItems).where(eq(workItems.kind, kind));
});

function hop(run: string, n: number): HandoffWork {
  return {
    fromBotId: "assistant",
    toBotId: `bot-${n}`,
    actorId: "user-1",
    threadId: "thread-1",
    runId: run,
    depth: 1,
    task: `task ${n}`,
  };
}

describe("a batch of hops and a lease that can run out", () => {
  test("two concurrent hops in one thread have independent verified lineage", async () => {
    const run = randomUUID();
    const targets = [`concurrent-a-${run}`, `concurrent-b-${run}`];
    for (const [index, target] of targets.entries()) {
      await queue.offer({
        kind,
        key: `${run}:${index}`,
        payload: { ...hop(run, index), toBotId: target } as unknown as Record<
          string,
          unknown
        >,
      });
    }
    const shared = {
      queue,
      sign: () => ({ lineage: "signed", toolCalls: [] }),
      auditStore: createAuditStore(database),
      evolution: createEvolutionCheckpointGate(database),
      kind,
      delivery: { deliver: async () => ({ answer: "verified answer" }) },
    };
    const [left, right] = await Promise.all([
      createHandoffRunner({ ...shared, owner: `replica-a-${run}` }).sweep(),
      createHandoffRunner({ ...shared, owner: `replica-b-${run}` }).sweep(),
    ]);
    expect([...left.delivered, ...right.delivered].sort()).toEqual(
      targets.sort(),
    );
    const rollbacks = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "agent.evolution_rolled_back"),
          inArray(auditEvents.targetId, targets),
        ),
      );
    expect(rollbacks).toHaveLength(0);
    const checkpoints = await database
      .select({ chainId: evolutionCheckpoints.chainId })
      .from(evolutionCheckpoints)
      .where(
        inArray(evolutionCheckpoints.chainId, [
          `thread-1:${run}:0`,
          `thread-1:${run}:1`,
        ]),
      );
    expect(checkpoints).toHaveLength(2);
  });
  /*
   * A claim leases the whole batch from one moment, and the batch is delivered one at a time. A
   * heartbeat that only covers the hop in flight leaves the rest on a lease that expires while the
   * first one runs: another replica claims them, and this one delivers them anyway. Two model calls,
   * two answers in somebody's conversation, and both replicas reporting success.
   */
  test("the tail of a batch is not delivered twice while its head is running", async () => {
    const run = randomUUID();
    for (const n of [1, 2, 3]) {
      await queue.offer({
        kind,
        key: `${run}:${n}`,
        payload: hop(run, n) as unknown as Record<string, unknown>,
      });
    }

    const ran: string[] = [];
    const held = Promise.withResolvers<void>();
    const shared = {
      queue,
      sign: () => ({ lineage: "signed", toolCalls: [] }),
      auditStore: silent,
      // Small enough to drive in milliseconds; the property is one duration outrunning another.
      leaseMs: 400,
      renewEveryMs: 100,
      limit: 3,
      kind,
    };

    const slow = createHandoffRunner({
      ...shared,
      owner: "replica-a",
      delivery: {
        deliver: async ({ work }) => {
          ran.push(`a:${work.toBotId}`);
          if (work.toBotId === "bot-1") await held.promise;
          return { answer: null };
        },
      },
    });
    const quick = createHandoffRunner({
      ...shared,
      owner: "replica-b",
      delivery: {
        deliver: async ({ work }) => {
          ran.push(`b:${work.toBotId}`);
          return { answer: null };
        },
      },
    });

    const sweepA = slow.sweep();
    // Long enough that an unrenewed lease taken at the same moment would have lapsed twice over.
    await new Promise((resolve) => setTimeout(resolve, 900));
    const reportB = await quick.sweep();
    held.resolve();
    const reportA = await sweepA;

    expect(reportA.delivered).toEqual(["bot-1", "bot-2", "bot-3"]);
    // Nothing was left for the other replica to take, so nothing ran twice.
    expect(reportB.delivered).toEqual([]);
    expect(ran).toEqual(["a:bot-1", "a:bot-2", "a:bot-3"]);
  });

  /*
   * And when a lease really has gone, the model call is the thing not to spend. Finding out after
   * delivering is finding out too late.
   */
  test("a hop whose lease went elsewhere is not run again by its old owner", async () => {
    const run = randomUUID();
    for (const n of [1, 2]) {
      await queue.offer({
        kind,
        key: `${run}:${n}`,
        payload: hop(run, n) as unknown as Record<string, unknown>,
      });
    }

    const ran: string[] = [];
    const held = Promise.withResolvers<void>();
    const slow = createHandoffRunner({
      queue,
      owner: "replica-a",
      sign: () => ({ lineage: "signed", toolCalls: [] }),
      auditStore: silent,
      leaseMs: 400,
      // Never refreshed, which is what a paused process looks like from the database's side.
      renewEveryMs: 60_000,
      limit: 2,
      kind,
      delivery: {
        deliver: async ({ work }) => {
          ran.push(work.toBotId);
          if (work.toBotId === "bot-1") await held.promise;
          return { answer: null };
        },
      },
    });

    const sweep = slow.sweep();
    await new Promise((resolve) => setTimeout(resolve, 700));
    // Somebody else takes the lapsed hop while the first is still running.
    const taken = await queue.claim({
      kind,
      owner: "replica-b",
      leaseMs: 10_000,
      limit: 5,
    });
    held.resolve();
    const report = await sweep;

    expect(taken.map((item) => item.key)).toContain(`${run}:2`);
    // Delivered once, by whoever holds it now, and not a second time by its old owner.
    expect(ran).toEqual(["bot-1"]);
    expect(report.skipped.map((entry) => entry.reason)).toContain(
      "the lease went elsewhere",
    );
  });
});
