import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import { createEvolutionCheckpointGate } from "../src/agents/evolution-checkpoints";
import { createDatabase } from "../src/db/client";
import { evolutionCheckpoints } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const prefix = `evolution-test-${randomUUID()}`;
const chain = (suffix: string) => `${prefix}-${suffix}`;

afterAll(async () => {
  await database
    .delete(evolutionCheckpoints)
    .where(like(evolutionCheckpoints.chainId, `${prefix}%`));
  await database.$client.close();
});

describe("persistent runtime evolution checkpoints", () => {
  test("promotes a verified candidate and survives a new gate instance", async () => {
    const firstGate = createEvolutionCheckpointGate(database);
    const id = chain("restart");
    const checkpoint = await firstGate.checkpoint(id);
    const decision = await firstGate.promote({
      checkpoint,
      candidateId: "run-1",
      answer: "verified answer",
    });
    expect(decision.promoted).toBe(true);
    expect(await createEvolutionCheckpointGate(database).state(id)).toBe(
      decision.nextStateHash,
    );
  });

  test("serializes replicas and rejects a stale predecessor", async () => {
    const replicaA = createEvolutionCheckpointGate(database);
    const replicaB = createEvolutionCheckpointGate(database);
    const id = chain("replicas");
    const [a, b] = await Promise.all([
      replicaA.checkpoint(id),
      replicaB.checkpoint(id),
    ]);
    const first = await replicaA.promote({
      checkpoint: a,
      candidateId: "run-a",
      answer: "first",
    });
    const second = await replicaB.promote({
      checkpoint: b,
      candidateId: "run-b",
      answer: "stale branch",
    });
    expect(first.promoted).toBe(true);
    expect(second.promoted).toBe(false);
    expect(second.reasons).toContain(
      "candidate is based on an untrusted or stale parent state",
    );
    expect(await replicaB.state(id)).toBe(first.nextStateHash);
  });

  test("does not mistake answer text or a displayed diff for an applied dependency change", async () => {
    const gate = createEvolutionCheckpointGate(database);
    const id = chain("debt");
    const decision = await gate.promote({
      checkpoint: await gate.checkpoint(id),
      candidateId: "run-1",
      answer: "```diff\n+npm install left-pad\n```",
    });
    expect(decision.promoted).toBe(true);
  });

  test("rejects debt measured by the execution layer from an actual change", async () => {
    const gate = createEvolutionCheckpointGate(database);
    const id = chain("measured-debt");
    const decision = await gate.promote({
      checkpoint: await gate.checkpoint(id),
      candidateId: "run-1",
      answer: "change applied",
      debt: {
        addedDependencies: 1,
        complexityPoints: 0,
        duplicatedLines: 0,
        maximumFileLines: 1,
      },
    });
    expect(decision.promoted).toBe(false);
    expect(decision.reasons).toContain(
      "technical-debt budget exceeded: addedDependencies",
    );
  });

  test("names a violated live hop invariant instead of promoting ceremony", async () => {
    const gate = createEvolutionCheckpointGate(database);
    const id = chain("tool-budget");
    const decision = await gate.promote({
      checkpoint: await gate.checkpoint(id),
      candidateId: "run-over-budget",
      answer: "otherwise valid answer",
      verification: {
        toolCallCount: 33,
        maximumToolCalls: 32,
        relayRequired: true,
      },
    });
    expect(decision.promoted).toBe(false);
    expect(decision.reasons.join(" ")).toContain("tool-call-budget");
  });
});
