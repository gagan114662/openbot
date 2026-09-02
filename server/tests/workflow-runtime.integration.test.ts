import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  factoryManagedJobs,
  factoryModelBenchmarks,
  factoryWorkflowArtifacts,
  factoryWorkflowRuns,
  factoryWorkflowStages,
} from "../src/db/schema";
import { createSoftwareFactoryStore } from "../src/software-factory/store";
import {
  artifactChecksum,
  createWorkflowRuntime,
} from "../src/software-factory/workflow-runtime";
import { createWorkflowWorker } from "../src/software-factory/workflow-worker";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const tenantId = `workflow-test-${crypto.randomUUID()}`;
const store = createSoftwareFactoryStore(database, tenantId);
const runtime = createWorkflowRuntime(database, tenantId);

afterAll(async () => {
  await database
    .delete(factoryWorkflowArtifacts)
    .where(eq(factoryWorkflowArtifacts.runId, runId));
  await database
    .delete(factoryWorkflowStages)
    .where(eq(factoryWorkflowStages.runId, runId));
  await database
    .delete(factoryWorkflowRuns)
    .where(eq(factoryWorkflowRuns.tenantId, tenantId));
  await database
    .delete(factoryManagedJobs)
    .where(eq(factoryManagedJobs.tenantId, tenantId));
  await database
    .delete(factoryModelBenchmarks)
    .where(eq(factoryModelBenchmarks.tenantId, tenantId));
});

let runId = crypto.randomUUID();

describe("durable workflow runtime", () => {
  test("repairs within budget, enforces dependencies, pauses, resumes, and requires approval", async () => {
    await store.benchmark({
      model: "worker-small",
      task: "ci-repair",
      quality: 0.9,
      successfulOutcomes: 9,
      attemptedOutcomes: 10,
      totalCostMicros: 900,
      enabled: true,
    });
    const queued = await store.queueJob("admin", {
      kind: "ci-repair",
      tier: "managed",
      objective: "repair the failed gate",
      trigger: "github-actions",
      minimumQuality: 0.8,
    });
    const run = await runtime.create({
      jobId: queued.job.id,
      maximumAttempts: 2,
      concurrencyLimit: 1,
      stages: [
        {
          id: "implement",
          objective: "write the repair",
          requiredContext: ["issue"],
          dependsOn: [],
        },
        {
          id: "verify",
          objective: "independently verify the repair",
          requiredContext: ["acceptance"],
          dependsOn: ["implement"],
        },
      ],
    });
    runId = run.id;

    expect((await runtime.claim("worker-a"))?.id).toBe(run.id);
    expect(
      (await runtime.readyStages(run.id)).map((stage) => stage.stageId),
    ).toEqual(["implement"]);
    expect(
      await runtime.startStage(run.id, "implement", "fresh-worker-1"),
    ).not.toBeNull();
    await expect(
      runtime.completeStage(run.id, "implement", {
        summary: "claimed success without evidence",
        sessionId: "fresh-worker-1",
        reviewerSessionId: "fresh-reviewer-invalid",
        verification: {
          accepted: true,
          summary: "invalid because evidence is absent",
          checks: ["schema"],
        },
        artifacts: [],
      }),
    ).rejects.toThrow();
    expect(await runtime.failStage(run.id, "implement", "test failed")).toEqual(
      {
        terminal: false,
        attempts: 1,
      },
    );

    expect(
      await runtime.startStage(run.id, "implement", "fresh-worker-2"),
    ).not.toBeNull();
    await runtime.completeStage(run.id, "implement", {
      summary: "repair passes its focused test",
      sessionId: "fresh-worker-2",
      reviewerSessionId: "fresh-reviewer-2",
      verification: {
        accepted: true,
        summary: "focused test independently checked",
        checks: ["bun test focused.test.ts"],
      },
      artifacts: [
        {
          kind: "test-result",
          uri: "artifact://run/focused-test.txt",
          content: "1 passed, 0 failed",
          checksum: artifactChecksum("1 passed, 0 failed"),
          revision: "deadbeef",
          producerSessionId: "fresh-worker-2",
          command: "bun test focused.test.ts",
          exitCode: 0,
          metadata: { passed: 1, failed: 0 },
        },
      ],
    });
    expect(
      (await runtime.readyStages(run.id)).map((stage) => stage.stageId),
    ).toEqual(["verify"]);

    expect(await runtime.requestPause(run.id)).not.toBeNull();
    expect(await runtime.claim("worker-a")).toBeNull();
    expect((await runtime.snapshot(run.id))?.run.status).toBe("paused");
    expect(
      await runtime.steer(run.id, "admin", "also run the regression test"),
    ).not.toBeNull();
    expect(await runtime.resume(run.id)).not.toBeNull();
    expect((await runtime.claim("worker-b"))?.id).toBe(run.id);

    expect(
      await runtime.startStage(run.id, "verify", "fresh-reviewer-1"),
    ).not.toBeNull();
    await runtime.completeStage(run.id, "verify", {
      summary: "independent regression gate passed",
      sessionId: "fresh-reviewer-1",
      reviewerSessionId: "fresh-reviewer-verify",
      verification: {
        accepted: true,
        summary: "review artifact independently checked",
        checks: ["artifact checksum", "revision binding"],
      },
      artifacts: [
        {
          kind: "review-report",
          uri: "artifact://run/review.json",
          content: '{"accepted":true}',
          checksum: artifactChecksum('{"accepted":true}'),
          revision: "deadbeef",
          producerSessionId: "fresh-reviewer-1",
          metadata: { accepted: true },
        },
      ],
    });
    expect((await runtime.snapshot(run.id))?.run.status).toBe(
      "awaiting_approval",
    );
    expect(await runtime.approve(run.id, "admin")).not.toBeNull();
    const completed = await runtime.snapshot(run.id);
    expect(completed?.run).toMatchObject({
      status: "succeeded",
      approvedBy: "admin",
    });
    expect(completed?.artifacts).toHaveLength(2);
    expect(completed?.stages.map((stage) => stage.sessionId)).toEqual([
      "fresh-worker-2",
      "fresh-reviewer-1",
    ]);
  });

  test("a production worker repairs a rejected candidate within the persisted attempt budget", async () => {
    const queued = await store.queueJob("admin", {
      kind: "ci-repair",
      tier: "managed",
      objective: "repair through the live durable worker",
      trigger: "github-actions",
      minimumQuality: 0.8,
    });
    const run = await runtime.create({
      jobId: queued.job.id,
      maximumAttempts: 2,
      concurrencyLimit: 1,
      stages: [
        {
          id: "repair",
          objective: "repair and prove the failed gate",
          requiredContext: [],
          dependsOn: [],
        },
      ],
    });
    let reviews = 0;
    let nextSession = 0;
    const worker = createWorkflowWorker({
      runtime,
      workerId: "production-worker-test",
      sessionId: () => `session-${++nextSession}`,
      executor: {
        async execute({ sessionId }) {
          const content = reviews === 0 ? "candidate one" : "candidate two";
          return {
            sessionId,
            summary: content,
            artifacts: [
              {
                kind: "patch",
                uri: `artifact://${run.id}/${content.replace(" ", "-")}`,
                content,
                checksum: artifactChecksum(content),
                revision: "deadbeef",
                producerSessionId: sessionId,
              },
            ],
          };
        },
        async review({ sessionId, candidate }) {
          reviews += 1;
          return {
            accepted: reviews === 2,
            summary: `${sessionId} independently reviewed ${candidate.summary}`,
            checks: ["revision", "checksum", "focused test"],
          };
        },
      },
    });

    expect(await worker.runOnce()).toMatchObject({ claimed: true, stages: 1 });
    expect((await runtime.snapshot(run.id))?.stages[0]).toMatchObject({
      status: "pending",
      attempts: 1,
    });
    expect(await worker.runOnce()).toMatchObject({ claimed: true, stages: 1 });
    const finished = await runtime.snapshot(run.id);
    expect(finished?.run.status).toBe("awaiting_approval");
    expect(finished?.stages[0]).toMatchObject({
      status: "succeeded",
      attempts: 2,
      sessionId: "session-3",
      reviewerSessionId: "session-4",
    });
    expect(finished?.artifacts[0]?.content).toBe("candidate two");
    await worker.drain();
  });

  test("a SIGKILLed worker is recovered from its durable lease with the attempt preserved", async () => {
    const queued = await store.queueJob("admin", {
      kind: "ci-repair",
      tier: "managed",
      objective: "survive a dead worker",
      trigger: "crash-proof",
      minimumQuality: 0.8,
    });
    const run = await runtime.create({
      jobId: queued.job.id,
      maximumAttempts: 2,
      concurrencyLimit: 1,
      stages: [
        {
          id: "crash-stage",
          objective: "resume after process death",
          requiredContext: [],
          dependsOn: [],
        },
      ],
    });
    const child = Bun.spawn(
      ["bun", "server/tests/fixtures/workflow-crash-worker.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          WORKFLOW_TEST_TENANT: tenantId,
          WORKFLOW_TEST_RUN: run.id,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("STAGE_STARTED");
    child.kill(9);
    expect(await child.exited).not.toBe(0);
    await Bun.sleep(150);

    expect((await runtime.claim("replacement-worker", 1_000))?.id).toBe(run.id);
    const recovered = await runtime.snapshot(run.id);
    expect(recovered?.stages[0]).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: "Worker lease expired before a result was committed.",
    });
    expect(
      recovered?.events.map((event) => [
        event.entity,
        event.fromStatus,
        event.toStatus,
      ]),
    ).toContainEqual(["stage", "running", "pending"]);
    await runtime.requestAbort(run.id);
  });

  test("pause and steering interrupt active work, then resume from the durable stage", async () => {
    const queued = await store.queueJob("admin", {
      kind: "ci-repair",
      tier: "managed",
      objective: "honor live operator control",
      trigger: "operator-proof",
      minimumQuality: 0.8,
    });
    const run = await runtime.create({
      jobId: queued.job.id,
      maximumAttempts: 3,
      concurrencyLimit: 1,
      stages: [
        {
          id: "controlled",
          objective: "obey control",
          requiredContext: [],
          dependsOn: [],
        },
      ],
    });
    let executions = 0;
    const worker = createWorkflowWorker({
      runtime,
      workerId: "controlled-worker",
      executor: {
        async execute({ sessionId, signal }) {
          executions += 1;
          if (executions < 3)
            await new Promise<never>((_resolve, reject) =>
              signal.addEventListener(
                "abort",
                () => reject(new Error(String(signal.reason))),
                {
                  once: true,
                },
              ),
            );
          const content = "control-aware result";
          return {
            sessionId,
            summary: content,
            artifacts: [
              {
                kind: "control-proof",
                uri: `workflow://${run.id}/control`,
                content,
                checksum: artifactChecksum(content),
                revision: "deadbeef",
                producerSessionId: sessionId,
              },
            ],
          };
        },
        async review() {
          return {
            accepted: true,
            summary: "fresh review",
            checks: ["control history"],
          };
        },
      },
    });

    const first = worker.runOnce();
    while ((await runtime.snapshot(run.id))?.stages[0]?.status !== "running")
      await Bun.sleep(10);
    await runtime.requestPause(run.id);
    await first;
    await runtime.claim("controlled-worker");
    expect((await runtime.snapshot(run.id))?.run.status).toBe("paused");
    expect((await runtime.snapshot(run.id))?.stages[0]?.attempts).toBe(1);

    await runtime.resume(run.id);
    const second = worker.runOnce();
    while ((await runtime.snapshot(run.id))?.stages[0]?.attempts !== 2)
      await Bun.sleep(10);
    await runtime.steer(run.id, "human-admin", "also run the regression test");
    await second;
    expect((await runtime.snapshot(run.id))?.stages[0]).toMatchObject({
      status: "pending",
      attempts: 2,
      lastError: "Restarted to apply new operator steering.",
    });

    await worker.runOnce();
    expect((await runtime.snapshot(run.id))?.run.status).toBe(
      "awaiting_approval",
    );
    expect((await runtime.snapshot(run.id))?.stages[0]?.attempts).toBe(3);
    await worker.drain();
  });

  test("a slow stage renews its lease so another replica cannot reclaim it", async () => {
    const queued = await store.queueJob("admin", {
      kind: "ci-repair",
      tier: "managed",
      objective: "hold one durable lease",
      trigger: "lease-heartbeat-proof",
      minimumQuality: 0.8,
    });
    const run = await runtime.create({
      jobId: queued.job.id,
      maximumAttempts: 1,
      concurrencyLimit: 1,
      stages: [
        {
          id: "slow",
          objective: "remain uniquely owned",
          requiredContext: [],
          dependsOn: [],
        },
      ],
    });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = createWorkflowWorker({
      runtime,
      workerId: "heartbeat-worker",
      leaseMs: 90,
      heartbeatMs: 20,
      stageTimeoutMs: 1_000,
      executor: {
        async execute({ sessionId }) {
          await held;
          const content = "held by one worker";
          return {
            sessionId,
            summary: content,
            artifacts: [
              {
                kind: "lease-proof",
                uri: `workflow://${run.id}/lease`,
                content,
                checksum: artifactChecksum(content),
                revision: "deadbeef",
                producerSessionId: sessionId,
              },
            ],
          };
        },
        async review() {
          return {
            accepted: true,
            summary: "lease evidence accepted",
            checks: ["exclusive lease"],
          };
        },
      },
    });
    const activeRun = worker.runOnce();
    while ((await runtime.snapshot(run.id))?.stages[0]?.status !== "running")
      await Bun.sleep(5);
    await Bun.sleep(180);
    expect(await runtime.claim("competing-replica", 90)).toBeNull();
    release();
    await activeRun;
    expect((await runtime.snapshot(run.id))?.run.status).toBe(
      "awaiting_approval",
    );
  });

  test("a stage that exceeds its deadline enters the bounded failure path", async () => {
    const queued = await store.queueJob("admin", {
      kind: "ci-repair",
      tier: "managed",
      objective: "bound a hung model",
      trigger: "deadline-proof",
      minimumQuality: 0.8,
    });
    const run = await runtime.create({
      jobId: queued.job.id,
      maximumAttempts: 1,
      concurrencyLimit: 1,
      stages: [
        {
          id: "hung",
          objective: "time out",
          requiredContext: [],
          dependsOn: [],
        },
      ],
    });
    const worker = createWorkflowWorker({
      runtime,
      workerId: "deadline-worker",
      stageTimeoutMs: 40,
      executor: {
        async execute({ signal }) {
          await new Promise<never>((_resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(new Error(String(signal.reason))),
              { once: true },
            ),
          );
        },
        async review() {
          throw new Error("review must not run");
        },
      },
    });
    await worker.runOnce();
    expect((await runtime.snapshot(run.id))?.stages[0]).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "Managed stage exceeded its 40 ms execution deadline.",
    });
  });
});
