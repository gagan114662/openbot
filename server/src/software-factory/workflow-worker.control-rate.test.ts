import { expect, test } from "bun:test";
import { artifactChecksum } from "./workflow-runtime";
import { createWorkflowWorker } from "./workflow-worker";

test("a 60-second running stage performs fewer than one database query per second", async () => {
  let controlReads = 0;
  let databaseQueries = 0;
  let claimed = false;
  const stage = {
    stageId: "execute",
    status: "pending",
    attempts: 0,
    checks: { items: [] },
  };
  const snapshot = {
    run: {
      id: "rate-run",
      status: "running",
      steering: { events: [] },
      pauseRequested: false,
      abortRequested: false,
    },
    stages: [stage],
    artifacts: [],
  };
  const runtime = {
    claim: async () => {
      if (claimed) return null;
      claimed = true;
      return snapshot.run;
    },
    readyStages: async () => [stage],
    startStage: async () => stage,
    snapshot: async () => {
      // The production snapshot projection is four SQL queries.
      databaseQueries += 4;
      return snapshot;
    },
    control: async () => {
      controlReads += 1;
      // The production control projection is exactly one SQL query.
      databaseQueries += 1;
      return snapshot.run;
    },
    renewLease: async () => true,
    completeStage: async () => ({}),
    activeRunIds: async () => [],
  };
  const content = "bounded result";
  const worker = createWorkflowWorker({
    runtime: runtime as never,
    workerId: "rate-worker",
    heartbeatMs: 10_000,
    executor: {
      harness: "routed",
      run: async ({ sessionId }: { sessionId: string }) => {
        await new Promise((resolve) => setTimeout(resolve, 60_500));
        return {
          sessionId,
          summary: content,
          artifacts: [
            {
              kind: "proof",
              uri: "proof://rate",
              content,
              checksum: artifactChecksum(content),
              revision: "revision",
              producerSessionId: sessionId,
              exitCode: 0,
            },
          ],
        };
      },
      review: async () => ({
        accepted: true,
        summary: "accepted",
        checks: ["rate"],
      }),
      interrupt: async () => {},
    },
  });
  const startedAt = performance.now();
  await worker.runOnce();
  const seconds = (performance.now() - startedAt) / 1_000;
  const afterQueriesPerSecond = databaseQueries / seconds;
  const beforeQueriesPerSecond = 4 * (1_000 / 250);
  console.info(
    `workflow control query rate: before=${beforeQueriesPerSecond.toFixed(2)}/s after=${afterQueriesPerSecond.toFixed(2)}/s controls=${controlReads} seconds=${seconds.toFixed(2)}`,
  );
  expect(afterQueriesPerSecond).toBeLessThan(1);
  expect(controlReads).toBeGreaterThanOrEqual(47);
  expect(controlReads).toBeLessThanOrEqual(49);
}, 70_000);
