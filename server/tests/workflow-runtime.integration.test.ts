import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  auditEvents,
  factoryManagedJobs,
  factoryModelBenchmarks,
  factoryWorkflowArtifacts,
  factoryWorkflowEvents,
  factoryWorkflowRuns,
  factoryWorkflowStages,
} from "../src/db/schema";
import { createClaudeWorkflowExecutor } from "../src/software-factory/codex-workflow-executor";
import { createSoftwareFactoryRoutes } from "../src/software-factory/routes";
import { createSoftwareFactoryStore } from "../src/software-factory/store";
import {
  artifactChecksum,
  createWorkflowRuntime,
} from "../src/software-factory/workflow-runtime";
import {
  createWorkflowWorker,
  HarnessUnavailableError,
  StageExecutionFailure,
} from "../src/software-factory/workflow-worker";
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
  /**
   * `claim` takes the oldest claimable run in the tenant, and earlier tests in this
   * file leave runs behind that are still claimable. A worker in a later test would
   * then pick up somebody else's run instead of its own. Parking the others makes
   * these tests depend on their own run rather than on file ordering; `claim`
   * filters on `abortRequested`, so this takes effect immediately.
   */
  const isolateRun = async (keepRunId: string) => {
    const others = await database
      .select({
        id: factoryWorkflowRuns.id,
        status: factoryWorkflowRuns.status,
      })
      .from(factoryWorkflowRuns)
      .where(eq(factoryWorkflowRuns.tenantId, tenantId));
    for (const other of others)
      if (
        other.id !== keepRunId &&
        ["queued", "running", "pausing", "paused"].includes(other.status)
      )
        await runtime.requestAbort(other.id);
  };

  test("commits exactly one privacy-safe audit row with each durable control transition", async () => {
    await store.benchmark({
      source: "measured",
      model: "audit-model",
      task: "ci-repair",
      quality: 0.9,
      successfulOutcomes: 1,
      attemptedOutcomes: 1,
      totalCostMicros: 0,
      enabled: true,
    });
    const queued = await store.queueJob("audit-admin", {
      kind: "ci-repair",
      tier: "managed",
      objective: "audit every control transition",
      trigger: "control-audit-proof",
      minimumQuality: 0.8,
    });
    const controlled = await runtime.create({
      jobId: queued.job.id,
      maximumAttempts: 1,
      concurrencyLimit: 1,
      stages: [
        {
          id: "control",
          objective: "remain controllable",
          requiredContext: [],
          dependsOn: [],
        },
      ],
    });
    await runtime.requestPause(controlled.id, {
      actorId: "audit-admin",
      fromStatus: "queued",
    });
    await runtime.resume(controlled.id, {
      actorId: "audit-admin",
      fromStatus: "pausing",
    });
    const instruction = "Use the bounded repair path";
    const instructionHash = new Bun.CryptoHasher("sha256")
      .update(instruction)
      .digest("hex");
    await runtime.steer(controlled.id, "audit-admin", instruction, {
      fromStatus: "queued",
      instructionHash,
    });
    expect((await runtime.snapshot(controlled.id))?.run.steering).toMatchObject(
      {
        events: [
          expect.objectContaining({ actorId: "audit-admin", instruction }),
        ],
      },
    );
    await runtime.requestAbort(controlled.id, {
      actorId: "audit-admin",
      fromStatus: "queued",
    });

    const approvalJob = await store.queueJob("audit-admin", {
      kind: "ci-repair",
      tier: "managed",
      objective: "audit approval",
      trigger: "control-audit-proof",
      minimumQuality: 0.8,
    });
    const approval = await runtime.create({
      jobId: approvalJob.job.id,
      maximumAttempts: 1,
      concurrencyLimit: 1,
      stages: [
        {
          id: "approved",
          objective: "be approved",
          requiredContext: [],
          dependsOn: [],
        },
      ],
    });
    await database
      .update(factoryWorkflowRuns)
      .set({ status: "awaiting_approval" })
      .where(eq(factoryWorkflowRuns.id, approval.id));
    await runtime.approve(
      approval.id,
      { id: "audit-admin", role: "admin" },
      {
        fromStatus: "awaiting_approval",
      },
    );

    const events = await database
      .select()
      .from(auditEvents)
      .where(inArray(auditEvents.targetId, [controlled.id, approval.id]));
    expect(events).toHaveLength(5);
    expect(
      events.map((event) => ({
        actor: event.actorUserId,
        runId: event.targetId,
        action: (event.payload as { action: string }).action,
        from: (event.payload as { fromStatus: string }).fromStatus,
        to: (event.payload as { toStatus: string }).toStatus,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          actor: "audit-admin",
          runId: controlled.id,
          action: "pause",
          from: "queued",
          to: "pausing",
        },
        {
          actor: "audit-admin",
          runId: controlled.id,
          action: "resume",
          from: "pausing",
          to: "queued",
        },
        {
          actor: "audit-admin",
          runId: controlled.id,
          action: "steer",
          from: "queued",
          to: "queued",
        },
        {
          actor: "audit-admin",
          runId: controlled.id,
          action: "abort",
          from: "queued",
          to: "aborted",
        },
        {
          actor: "audit-admin",
          runId: approval.id,
          action: "approve",
          from: "awaiting_approval",
          to: "succeeded",
        },
      ]),
    );
    const steer = events.find(
      (event) => (event.payload as { action?: string }).action === "steer",
    );
    expect(steer?.payload).toMatchObject({ instructionHash });
    expect(JSON.stringify(steer?.payload)).not.toContain(instruction);

    const rollbackJob = await store.queueJob("audit-admin", {
      kind: "ci-repair",
      tier: "managed",
      objective: "prove audit and control are atomic",
      trigger: "control-audit-rollback-proof",
      minimumQuality: 0.8,
    });
    const rollbackRuntime = createWorkflowRuntime(database, tenantId, {
      failControlAudit: async () => {
        throw new Error("injected audit failure");
      },
    });
    const rollbackRun = await rollbackRuntime.create({
      jobId: rollbackJob.job.id,
      maximumAttempts: 1,
      concurrencyLimit: 1,
      stages: [
        {
          id: "atomic",
          objective: "remain queued when audit fails",
          requiredContext: [],
          dependsOn: [],
        },
      ],
    });
    await expect(
      rollbackRuntime.requestPause(rollbackRun.id, {
        actorId: "audit-admin",
        fromStatus: "queued",
      }),
    ).rejects.toThrow("injected audit failure");
    expect((await rollbackRuntime.snapshot(rollbackRun.id))?.run.status).toBe(
      "queued",
    );
    await runtime.requestAbort(rollbackRun.id);
  });

  test("repairs within budget, enforces dependencies, pauses, resumes, and requires approval", async () => {
    await store.benchmark({
      source: "measured",
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
    expect(
      await runtime.failStage(
        run.id,
        "implement",
        "fresh-worker-1",
        "test failed",
      ),
    ).toEqual({
      terminal: false,
      attempts: 1,
    });

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
    expect(
      await runtime.approve(run.id, "benchmark-runner" as never),
    ).toBeNull();
    expect(
      (await runtime.snapshot(run.id))?.evidence.checks.humanApproval,
    ).toBe(false);
    expect(
      await runtime.approve(run.id, { id: "admin", role: "admin" }),
    ).not.toBeNull();
    const completed = await runtime.snapshot(run.id);
    expect(completed?.run).toMatchObject({
      status: "succeeded",
      approvedBy: "admin",
      completedBy: null,
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

  test("a malformed reviewer reply is retried without burning the worker attempt", async () => {
    const queued = await store.queueJob("admin", {
      kind: "ci-repair",
      tier: "managed",
      objective: "keep a valid candidate while retrying its reviewer",
      trigger: "review-schema-retry",
      minimumQuality: 0.8,
    });
    const run = await runtime.create({
      jobId: queued.job.id,
      maximumAttempts: 1,
      concurrencyLimit: 1,
      stages: [
        {
          id: "repair",
          objective: "produce one candidate",
          requiredContext: [],
          dependsOn: [],
        },
      ],
    });
    let nextSession = 0;
    let executions = 0;
    let reviews = 0;
    const reviewerSessions: string[] = [];
    const worker = createWorkflowWorker({
      runtime,
      workerId: "review-schema-worker",
      sessionId: () => `schema-session-${++nextSession}`,
      executor: {
        async execute({ sessionId }) {
          executions += 1;
          const content = "candidate retained across reviewer retry";
          return {
            sessionId,
            summary: content,
            artifacts: [
              {
                kind: "patch",
                uri: `artifact://${run.id}/candidate`,
                content,
                checksum: artifactChecksum(content),
                revision: "deadbeef",
                producerSessionId: sessionId,
              },
            ],
          };
        },
        async review({ sessionId }) {
          reviewerSessions.push(sessionId);
          reviews += 1;
          if (reviews === 1)
            throw new SyntaxError("Unexpected identifier Confirmed");
          return {
            accepted: true,
            summary: "structured reviewer reply",
            checks: ["schema"],
          };
        },
      },
    });

    expect(await worker.runOnce()).toMatchObject({ claimed: true, stages: 1 });
    const finished = await runtime.snapshot(run.id);
    expect(executions).toBe(1);
    expect(reviewerSessions).toEqual(["schema-session-2", "schema-session-3"]);
    expect(finished?.stages[0]).toMatchObject({
      status: "succeeded",
      attempts: 1,
      sessionId: "schema-session-1",
      reviewerSessionId: "schema-session-3",
    });
    expect(finished?.artifacts).toHaveLength(1);
    expect(finished?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: "reviewer",
          fromStatus: "malformed_output",
          toStatus: "retrying",
          detail: expect.objectContaining({
            reviewerSessionId: "schema-session-2",
            errorName: "SyntaxError",
          }),
        }),
      ]),
    );
  });

  test("a spawned Claude CLI contract retries malformed reviewer output while retaining attempt-one artifacts", async () => {
    const repository = await mkdtemp(join(tmpdir(), "openbot-claude-retry-"));
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "openbot-claude-retry-workspaces-"),
    );
    const script = join(repository, "fake-claude");
    const counter = join(repository, "review-count");
    try {
      const git = (...args: string[]) => {
        const result = Bun.spawnSync(["git", ...args], { cwd: repository });
        if (result.exitCode !== 0) throw new Error("git fixture failed");
      };
      git("init", "-q");
      git("config", "user.email", "claude-proof@openbot.test");
      git("config", "user.name", "Claude proof");
      await writeFile(join(repository, "README.md"), "proof\n");
      git("add", "README.md");
      git("commit", "-qm", "fixture");
      await writeFile(
        script,
        `#!/usr/bin/env bun
const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1] ?? "";
if (!args.includes("--json-schema")) process.exit(42);
if (!prompt.includes("Independently review")) {
  console.log(JSON.stringify({ structured_output: { summary: "attempt-one candidate", checks: ["self report"] } }));
} else {
  const count = Number(await Bun.file(${JSON.stringify(counter)}).text().catch(() => "0")) + 1;
  await Bun.write(${JSON.stringify(counter)}, String(count));
  console.log(JSON.stringify(count === 1
    ? { result: "Confirmed without JSON" }
    : { structured_output: { accepted: true, summary: "fresh review", checks: ["runtime evidence"] } }));
}
`,
      );
      await chmod(script, 0o700);
      await store.benchmark({
        source: "measured",
        harness: "claude",
        model: "claude-contract",
        task: "ci-repair",
        quality: 1,
        successfulOutcomes: 1,
        attemptedOutcomes: 1,
        totalCostMicros: 0,
        enabled: true,
      });
      const queued = await store.queueJob("admin", {
        kind: "ci-repair",
        tier: "managed",
        objective: "exercise the Claude structured-output retry",
        trigger: "claude-cli-retry-proof",
        minimumQuality: 0.8,
      });
      const run = await runtime.create({
        jobId: queued.job.id,
        maximumAttempts: 1,
        concurrencyLimit: 1,
        stages: [
          {
            id: "repair",
            objective: "retain the first candidate",
            requiredContext: [],
            dependsOn: [],
            checks: [
              {
                id: "diff-integrity",
                command: ["git", "diff", "--check"],
                timeoutMs: 10_000,
                required: true,
              },
            ],
          },
        ],
      });
      const worker = createWorkflowWorker({
        runtime,
        workerId: "claude-cli-retry-worker",
        sessionId: (() => {
          let id = 0;
          return () => `claude-cli-session-${++id}`;
        })(),
        executor: createClaudeWorkflowExecutor(repository, {
          binary: script,
          workspaceRoot,
        }),
      });
      await worker.runOnce();
      const snapshot = await runtime.snapshot(run.id);
      expect(snapshot?.stages[0]).toMatchObject({
        status: "succeeded",
        attempts: 1,
        sessionId: "claude-cli-session-1",
        reviewerSessionId: "claude-cli-session-3",
      });
      // Sorted, because the runtime does not promise an order here and asserting
      // one made this test flaky. `snapshot` orders artifacts by `createdAt`, but
      // Postgres `now()` is transaction-start time, so everything written in one
      // transaction shares a timestamp and the sort has nothing to separate. What
      // is guaranteed is which artifacts exist, so that is what this asserts.
      expect(
        snapshot?.artifacts.map((artifact) => artifact.kind).sort(),
      ).toEqual([
        "codex-stage-result",
        "model-prompt",
        "runtime-check",
        "runtime-check",
      ]);
      expect(snapshot?.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            entity: "reviewer",
            fromStatus: "malformed_output",
            toStatus: "retrying",
          }),
        ]),
      );
    } finally {
      await rm(repository, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("a human gate rejects its producer with feedback, then approves the repaired path", async () => {
    const queued = await store.queueJob("admin", {
      kind: "ci-repair",
      tier: "managed",
      objective: "prove stage-level human control",
      trigger: "human-gate-proof",
      minimumQuality: 0.8,
    });
    const run = await runtime.create({
      jobId: queued.job.id,
      maximumAttempts: 3,
      concurrencyLimit: 2,
      stages: [
        {
          id: "produce-a",
          objective: "produce A",
          requiredContext: [],
          dependsOn: [],
        },
        {
          id: "produce-b",
          objective: "produce B",
          requiredContext: [],
          dependsOn: [],
        },
        {
          id: "release",
          objective: "release",
          requiredContext: [],
          dependsOn: ["produce-a", "produce-b"],
          gate: {
            kind: "human",
            prompt: "Approve the produced change",
            roles: ["admin"],
          },
        },
      ],
    });
    const complete = async (
      stageId: string,
      sessionId: string,
      content: string,
    ) => {
      expect(
        await runtime.startStage(run.id, stageId, sessionId),
      ).not.toBeNull();
      await runtime.completeStage(run.id, stageId, {
        summary: content,
        sessionId,
        reviewerSessionId: `${sessionId}-reviewer`,
        verification: {
          accepted: true,
          summary: "independently verified",
          checks: ["checksum"],
        },
        artifacts: [
          {
            kind: "proof",
            uri: `artifact://${stageId}/${sessionId}`,
            content,
            checksum: artifactChecksum(content),
            revision: "deadbeef",
            producerSessionId: sessionId,
            exitCode: 0,
            metadata: {},
          },
        ],
      });
    };

    expect((await runtime.claim("gate-worker"))?.id).toBe(run.id);
    await complete("produce-a", "producer-a-1", "first candidate A");
    expect(
      (await runtime.snapshot(run.id))?.stages.find(
        (stage) => stage.stageId === "release",
      )?.status,
    ).toBe("pending");
    expect(
      (await runtime.snapshot(run.id))?.events.some(
        (event) =>
          event.entity === "human_gate" &&
          event.toStatus === "awaiting_approval",
      ),
    ).toBe(false);
    await complete("produce-b", "producer-b-1", "first candidate B");
    expect(await runtime.readyStages(run.id)).toEqual([]);
    expect(
      (await runtime.snapshot(run.id))?.stages.find(
        (stage) => stage.stageId === "release",
      )?.status,
    ).toBe("awaiting_approval");

    expect(
      await runtime.decideStageGate(run.id, "release", {
        actorId: "viewer-1",
        actorRole: "member",
        decision: "approve",
        revision: "deadbeef",
      }),
    ).toEqual({ status: "forbidden" });
    expect(
      (await runtime.snapshot(run.id))?.stages.find(
        (stage) => stage.stageId === "release",
      )?.status,
    ).toBe("awaiting_approval");

    const routes = createSoftwareFactoryRoutes(
      store,
      {} as never,
      tenantId,
      async (context, next) => {
        context.set("actor", {
          id: "admin-1",
          email: "admin@example.test",
          role: "admin",
        });
        await next();
      },
      undefined,
      undefined,
      runtime,
      { revision: "deadbeef", branch: "test", dirty: false },
    );
    const rejected = await routes.request(
      `/workflows/${run.id}/stages/release/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decision: "reject",
          feedback: "Add the missing rollback proof",
          producerStageId: "produce-a",
        }),
      },
    );
    expect(rejected.status).toBe(200);
    expect((await runtime.claim("gate-worker"))?.id).toBe(run.id);
    expect(
      (await runtime.readyStages(run.id)).map((stage) => stage.stageId),
    ).toEqual(["produce-a"]);
    expect(
      (await runtime.snapshot(run.id))?.stages.find(
        (stage) => stage.stageId === "produce-b",
      )?.status,
    ).toBe("succeeded");
    await complete(
      "produce-a",
      "producer-a-2",
      "candidate A with rollback proof",
    );
    expect(await runtime.readyStages(run.id)).toEqual([]);
    await database
      .update(factoryWorkflowRuns)
      .set({ leaseExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(factoryWorkflowRuns.id, run.id));
    const attemptsBeforeGateApproval = (
      await runtime.snapshot(run.id)
    )?.stages.map(({ stageId, attempts }) => [stageId, attempts]);
    expect(await runtime.claim("gate-thief")).toBeNull();
    expect(
      (await runtime.snapshot(run.id))?.stages.map(({ stageId, attempts }) => [
        stageId,
        attempts,
      ]),
    ).toEqual(attemptsBeforeGateApproval);
    await runtime.decideStageGate(run.id, "release", {
      actorId: "admin-1",
      actorRole: "admin",
      decision: "approve",
      revision: "deadbeef",
    });
    expect((await runtime.claim("gate-worker"))?.id).toBe(run.id);
    expect(
      (await runtime.readyStages(run.id)).map((stage) => stage.stageId),
    ).toEqual(["release"]);
    await complete("release", "release-1", "released");
    const snapshot = await runtime.snapshot(run.id);
    expect(
      snapshot?.stages.find((stage) => stage.stageId === "produce-a")?.attempts,
    ).toBe(2);
    expect(
      snapshot?.events
        .filter((event) => event.entity === "human_gate")
        .map((event) => event.toStatus),
    ).toEqual([
      "awaiting_approval",
      "rejected",
      "awaiting_approval",
      "approved",
    ]);
    expect(snapshot?.run.status).toBe("awaiting_approval");
    expect(
      snapshot?.artifacts.filter(
        (artifact) => artifact.kind === "human-decision",
      ),
    ).toHaveLength(2);
    expect(snapshot?.evidence.checks.producerBound).toBe(true);
    // Two rows with no ORDER BY come back in heap order, which Postgres does
    // not guarantee; CI caught the reversed sequence once. The claim is
    // reject-then-approve in time, so ask for time.
    const gateAudits = await database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.targetId, run.id))
      .orderBy(asc(auditEvents.createdAt));
    expect(
      gateAudits.map((event) => (event.payload as { action: string }).action),
    ).toEqual(["stage_reject", "stage_approve"]);
    expect(JSON.stringify(gateAudits)).not.toContain(
      "Add the missing rollback proof",
    );
  });

  test("failed runtime checks persist evidence, skip review, and feed the bounded repair", async () => {
    const queued = await store.queueJob("admin", {
      kind: "ci-repair",
      tier: "managed",
      objective: "repair a runtime check failure",
      trigger: "runtime-check-proof",
      minimumQuality: 0.8,
    });
    const run = await runtime.create({
      jobId: queued.job.id,
      maximumAttempts: 2,
      concurrencyLimit: 1,
      stages: [
        {
          id: "checked",
          objective: "pass the declared command",
          requiredContext: [],
          dependsOn: [],
          checks: [
            {
              id: "focused",
              command: ["bun", "test", "focused.test.ts"],
              timeoutMs: 30_000,
              required: true,
            },
          ],
        },
      ],
    });
    let executions = 0;
    let reviews = 0;
    const worker = createWorkflowWorker({
      runtime,
      workerId: "runtime-check-worker",
      sessionId: () => `check-session-${++executions}`,
      executor: {
        async execute({ sessionId, stage, snapshot }) {
          if (stage.attempts === 1) {
            expect(snapshot.artifacts).toHaveLength(0);
            const content = JSON.stringify({
              exitCode: 1,
              stderr: "expected 1, received 2",
            });
            throw new StageExecutionFailure("required check failed", [
              {
                kind: "runtime-check",
                uri: `workflow-check://${sessionId}/focused`,
                content,
                checksum: artifactChecksum(content),
                revision: "deadbeef",
                producerSessionId: sessionId,
                command: "bun test focused.test.ts",
                exitCode: 1,
                metadata: {
                  evidenceSource: "forged-self-report",
                  attemptStatus: "failed",
                },
              },
            ]);
          }
          expect(stage.lastError).toContain("required check failed");
          expect(snapshot.artifacts[0]).toMatchObject({
            kind: "runtime-check",
            exitCode: 1,
          });
          const content = "repair passed";
          return {
            sessionId,
            summary: content,
            artifacts: [
              {
                kind: "runtime-check",
                uri: `workflow-check://${sessionId}/focused`,
                content,
                checksum: artifactChecksum(content),
                revision: "deadbeef",
                producerSessionId: sessionId,
                command: "bun test focused.test.ts",
                exitCode: 0,
                metadata: { evidenceSource: "forged-self-report" },
              },
            ],
          };
        },
        async review() {
          reviews += 1;
          return {
            accepted: true,
            summary: "runtime evidence accepted",
            checks: ["runtime-check checksum"],
          };
        },
      },
    });

    await worker.runOnce();
    expect(reviews).toBe(0);
    expect((await runtime.snapshot(run.id))?.artifacts[0]).toMatchObject({
      kind: "runtime-check",
      exitCode: 1,
      metadata: { evidenceSource: "runtime-recorded" },
    });
    await worker.runOnce();
    expect(reviews).toBe(1);
    const snapshot = await runtime.snapshot(run.id);
    expect(snapshot?.run.status).toBe("awaiting_approval");
    expect(snapshot?.artifacts).toHaveLength(2);
    expect(
      snapshot?.artifacts.every(
        (artifact) =>
          (artifact.metadata as { evidenceSource?: string }).evidenceSource ===
          "runtime-recorded",
      ),
    ).toBe(true);
    expect(snapshot?.evidence.checks).toMatchObject({
      artifactChecksums: true,
      producerBound: true,
      commandsSucceeded: true,
    });
    await worker.drain();
  });

  test("a SIGKILLed worker restarts on the same hostname and completes with the attempt preserved", async () => {
    await store.benchmark({
      source: "measured",
      model: "restart-proof-model",
      task: "ci-repair",
      quality: 0.9,
      successfulOutcomes: 1,
      attemptedOutcomes: 1,
      totalCostMicros: 0,
      enabled: true,
    });
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
          HOSTNAME: "factory-host-proof",
          WORKFLOW_TEST_TENANT: tenantId,
          WORKFLOW_TEST_RUN: run.id,
          WORKFLOW_TEST_MODE: "crash",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const reader = child.stdout.getReader();
    const first = await reader.read();
    const killed = JSON.parse(new TextDecoder().decode(first.value)) as {
      event: string;
      workerId: string;
    };
    expect(killed).toMatchObject({ event: "STAGE_STARTED" });
    expect(killed.workerId).toContain("software-factory/factory-host-proof");
    child.kill(9);
    expect(await child.exited).not.toBe(0);
    await Bun.sleep(150);

    const restarted = Bun.spawn(
      ["bun", "server/tests/fixtures/workflow-crash-worker.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOSTNAME: "factory-host-proof",
          WORKFLOW_TEST_TENANT: tenantId,
          WORKFLOW_TEST_RUN: run.id,
          WORKFLOW_TEST_MODE: "recover",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const restartedOutput = await new Response(restarted.stdout).text();
    const restartedError = await new Response(restarted.stderr).text();
    expect(await restarted.exited).toBe(0);
    expect(restartedError).toBe("");
    const recoveredBy = JSON.parse(restartedOutput) as {
      event: string;
      workerId: string;
    };
    expect(recoveredBy).toMatchObject({ event: "STAGE_COMPLETED" });
    expect(recoveredBy.workerId).toContain(
      "software-factory/factory-host-proof",
    );
    expect(recoveredBy.workerId).not.toBe(killed.workerId);
    const recovered = await runtime.snapshot(run.id);
    expect(recovered?.run.status).toBe("awaiting_approval");
    expect(recovered?.stages[0]).toMatchObject({
      status: "succeeded",
      attempts: 2,
    });
    expect(
      recovered?.events.map((event) => [
        event.entity,
        event.fromStatus,
        event.toStatus,
      ]),
    ).toContainEqual(["stage", "running", "pending"]);
  }, 15_000);

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
    expect((await runtime.snapshot(run.id))?.stages[0]?.attempts).toBe(0);

    await runtime.resume(run.id);
    const second = worker.runOnce();
    while ((await runtime.snapshot(run.id))?.stages[0]?.attempts !== 1)
      await Bun.sleep(10);
    await runtime.steer(run.id, "human-admin", "also run the regression test");
    await second;
    expect((await runtime.snapshot(run.id))?.stages[0]).toMatchObject({
      status: "pending",
      attempts: 0,
      lastError: "Restarted to apply new operator steering.",
    });

    await worker.runOnce();
    expect((await runtime.snapshot(run.id))?.run.status).toBe(
      "awaiting_approval",
    );
    expect((await runtime.snapshot(run.id))?.stages[0]?.attempts).toBe(1);
    await worker.drain();
  });

  test("five pause cycles do not spend the one attempt before the stage succeeds", async () => {
    await store.benchmark({
      source: "measured",
      model: "pause-proof-model",
      task: "ci-repair",
      quality: 0.9,
      successfulOutcomes: 1,
      attemptedOutcomes: 1,
      totalCostMicros: 0,
      enabled: true,
    });
    const queued = await store.queueJob("admin", {
      kind: "ci-repair",
      tier: "managed",
      objective: "survive repeated operator pauses",
      trigger: "five-pause-proof",
      minimumQuality: 0.8,
    });
    const run = await runtime.create({
      jobId: queued.job.id,
      maximumAttempts: 1,
      concurrencyLimit: 1,
      stages: [
        {
          id: "pause-safe",
          objective: "finish after five pauses",
          requiredContext: [],
          dependsOn: [],
        },
      ],
    });
    let executions = 0;
    const worker = createWorkflowWorker({
      runtime,
      workerId: "five-pause-worker",
      executor: {
        async execute({ sessionId, signal }) {
          executions += 1;
          if (executions <= 5)
            await new Promise<never>((_resolve, reject) =>
              signal.addEventListener(
                "abort",
                () => reject(new Error(String(signal.reason))),
                { once: true },
              ),
            );
          const content = "completed after five pauses";
          return {
            sessionId,
            summary: content,
            artifacts: [
              {
                kind: "pause-proof",
                uri: `workflow://${run.id}/pause-proof`,
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
            summary: "pause budget preserved",
            checks: ["five pause cycles"],
          };
        },
      },
    });

    for (let cycle = 0; cycle < 5; cycle += 1) {
      const interrupted = worker.runOnce();
      while ((await runtime.snapshot(run.id))?.stages[0]?.status !== "running")
        await Bun.sleep(10);
      expect((await runtime.snapshot(run.id))?.stages[0]?.attempts).toBe(1);
      await runtime.requestPause(run.id);
      await interrupted;
      await runtime.claim("five-pause-worker");
      expect(await runtime.snapshot(run.id)).toMatchObject({
        run: { status: "paused" },
        stages: [{ status: "pending", attempts: 0 }],
      });
      await runtime.resume(run.id);
    }

    await worker.runOnce();
    expect(await runtime.snapshot(run.id)).toMatchObject({
      run: { status: "awaiting_approval" },
      stages: [{ status: "succeeded", attempts: 1 }],
    });
    expect(executions).toBe(6);
    await worker.drain();
  }, 15_000);

  test("two worker processes race and only the owning session can commit or fail the stage", async () => {
    await store.benchmark({
      source: "measured",
      model: "session-race-model",
      task: "ci-repair",
      quality: 0.9,
      successfulOutcomes: 1,
      attemptedOutcomes: 1,
      totalCostMicros: 0,
      enabled: true,
    });
    const queued = await store.queueJob("admin", {
      kind: "ci-repair",
      tier: "managed",
      objective: "bind writes to the live session",
      trigger: "session-race-proof",
      minimumQuality: 0.8,
    });
    const run = await runtime.create({
      jobId: queued.job.id,
      maximumAttempts: 1,
      concurrencyLimit: 1,
      stages: [
        {
          id: "owned",
          objective: "survive the same host restarting",
          requiredContext: [],
          dependsOn: [],
        },
      ],
    });
    expect((await runtime.claim("session-race-owner", 1_000))?.id).toBe(run.id);
    expect(
      await runtime.startStage(run.id, "owned", "live-process-session"),
    ).not.toBeNull();
    const spawnRacer = (mode: "winner" | "stale") =>
      Bun.spawn(["bun", "server/tests/fixtures/workflow-session-racer.ts"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          WORKFLOW_TEST_TENANT: tenantId,
          WORKFLOW_TEST_RUN: run.id,
          WORKFLOW_TEST_MODE: mode,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
    const winner = spawnRacer("winner");
    const stale = spawnRacer("stale");
    const staleOutput = await new Response(stale.stdout).text();
    const staleError = await new Response(stale.stderr).text();
    expect(await stale.exited).toBe(0);
    expect(staleError).toBe("");
    expect(JSON.parse(staleOutput)).toEqual({
      completion: {
        kind: "stale-session",
        expected: "live-process-session",
        actual: "stale-process-session",
      },
      failure: {
        kind: "stale-session",
        expected: "live-process-session",
        actual: "stale-process-session",
      },
      interruption: {
        kind: "stale-session",
        expected: "live-process-session",
        actual: "stale-process-session",
      },
    });
    const winnerOutput = await new Response(winner.stdout).text();
    const winnerError = await new Response(winner.stderr).text();
    expect(await winner.exited).toBe(0);
    expect(winnerError).toBe("");
    expect(JSON.parse(winnerOutput)).toMatchObject({
      status: "succeeded",
      sessionId: "live-process-session",
      attempts: 1,
    });
    const refused = await database
      .select()
      .from(factoryWorkflowEvents)
      .where(eq(factoryWorkflowEvents.runId, run.id));
    expect(
      refused
        .map((event) => event.detail)
        .filter(
          (detail) =>
            (detail as { reason?: string }).reason === "stale-session",
        ),
    ).toHaveLength(3);
    expect(await runtime.snapshot(run.id)).toMatchObject({
      run: { status: "awaiting_approval" },
      stages: [
        {
          status: "succeeded",
          sessionId: "live-process-session",
          attempts: 1,
          output: { summary: "winner process result" },
        },
      ],
    });
  });

  test("an expired final attempt terminates instead of being reclaimed forever", async () => {
    const queued = await store.queueJob("admin", {
      kind: "ci-repair",
      tier: "managed",
      objective: "terminate an exhausted crash",
      trigger: "terminal-crash-proof",
      minimumQuality: 0.8,
    });
    const run = await runtime.create({
      jobId: queued.job.id,
      maximumAttempts: 1,
      concurrencyLimit: 1,
      stages: [
        {
          id: "last-attempt",
          objective: "fail closed after a crash",
          requiredContext: [],
          dependsOn: [],
        },
      ],
    });
    expect((await runtime.claim("same-host", 20))?.id).toBe(run.id);
    expect(
      await runtime.startStage(run.id, "last-attempt", "dead-session"),
    ).not.toBeNull();
    await Bun.sleep(30);
    expect(await runtime.claim("same-host", 1_000)).toBeNull();
    expect(await runtime.snapshot(run.id)).toMatchObject({
      run: { status: "failed" },
      stages: [
        {
          status: "failed",
          attempts: 1,
          lastError: "Worker lease expired before a result was committed.",
        },
      ],
    });
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
    const worker = createWorkflowWorker({
      runtime,
      workerId: "heartbeat-worker",
      leaseMs: 90,
      heartbeatMs: 20,
      stageTimeoutMs: 1_000,
      executor: {
        async execute({ sessionId }) {
          const child = Bun.spawn(
            [process.execPath, "-e", "await Bun.sleep(180)"],
            { stdout: "pipe", stderr: "pipe" },
          );
          expect(await child.exited).toBe(0);
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
    await Bun.sleep(130);
    expect(await runtime.claim("competing-replica", 90)).toBeNull();
    await activeRun;
    expect((await runtime.snapshot(run.id))?.run.status).toBe(
      "awaiting_approval",
    );
    expect((await runtime.snapshot(run.id))?.stages[0]?.attempts).toBe(1);
    expect(
      (await runtime.snapshot(run.id))?.events.some(
        (event) =>
          (event.detail as { classification?: string }).classification ===
          "lease-policy",
      ),
    ).toBe(true);
  });

  test("a harness transport failure is audited, backed off, and refunds the attempt", async () => {
    const queued = await store.queueJob("admin", {
      kind: "ci-repair",
      tier: "managed",
      objective: "survive a provider outage",
      trigger: "harness-unavailable-proof",
      minimumQuality: 0.8,
    });
    const run = await runtime.create({
      jobId: queued.job.id,
      maximumAttempts: 1,
      concurrencyLimit: 1,
      stages: [
        {
          id: "transport",
          objective: "execute",
          requiredContext: [],
          dependsOn: [],
        },
      ],
    });
    const started = performance.now();
    const worker = createWorkflowWorker({
      runtime,
      workerId: "transport-worker",
      harnessBackoffMs: 40,
      executor: {
        async execute() {
          throw new HarnessUnavailableError(
            "codex failed (1): retries=4 max_retries",
          );
        },
        async review() {
          throw new Error("review must not run");
        },
      },
    });
    await worker.runOnce();
    expect(performance.now() - started).toBeGreaterThanOrEqual(35);
    const snapshot = await runtime.snapshot(run.id);
    expect(snapshot?.stages[0]).toMatchObject({
      status: "pending",
      attempts: 0,
    });
    expect(snapshot?.stages[0]?.lastError).toContain("harness-unavailable");
    expect(
      snapshot?.events.some(
        (event) =>
          (event.detail as { classification?: string }).classification ===
            "harness-unavailable" &&
          (event.detail as { attemptRefunded?: boolean }).attemptRefunded ===
            true,
      ),
    ).toBe(true);
  });

  test("losing a lease interrupts a live child and refunds its attempt", async () => {
    const queued = await store.queueJob("admin", {
      kind: "ci-repair",
      tier: "managed",
      objective: "interrupt a live child on lease loss",
      trigger: "lease-loss-proof",
      minimumQuality: 0.8,
    });
    const run = await runtime.create({
      jobId: queued.job.id,
      maximumAttempts: 1,
      concurrencyLimit: 1,
      stages: [
        {
          id: "live-child",
          objective: "wait",
          requiredContext: [],
          dependsOn: [],
        },
      ],
    });
    let childWasKilled = false;
    const worker = createWorkflowWorker({
      runtime: { ...runtime, renewLease: async () => false },
      workerId: "lease-loss-worker",
      leaseMs: 100,
      heartbeatMs: 20,
      executor: {
        async execute({ signal }) {
          const child = Bun.spawn(
            [process.execPath, "-e", "await Bun.sleep(1000)"],
            {
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          signal.addEventListener("abort", () => child.kill("SIGTERM"), {
            once: true,
          });
          await child.exited;
          childWasKilled = true;
          throw new Error(String(signal.reason));
        },
        async review() {
          throw new Error("review must not run");
        },
      },
    });
    await worker.runOnce();
    expect(childWasKilled).toBe(true);
    const snapshot = await runtime.snapshot(run.id);
    expect(snapshot?.stages[0]).toMatchObject({
      status: "pending",
      attempts: 0,
    });
    expect(snapshot?.stages[0]?.lastError).toContain("interrupted-by-lease");
    expect(
      snapshot?.events.some(
        (event) =>
          (event.detail as { classification?: string }).classification ===
          "interrupted-by-lease",
      ),
    ).toBe(true);
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
    await isolateRun(run.id);
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

  test("an exhausted pending stage cannot monopolize the workflow queue", async () => {
    const queued = await store.queueJob("admin", {
      kind: "ci-repair",
      tier: "managed",
      objective: "reconcile an exhausted pending stage",
      trigger: "no-progress-proof",
      minimumQuality: 0.8,
    });
    const run = await runtime.create({
      jobId: queued.job.id,
      maximumAttempts: 1,
      concurrencyLimit: 1,
      stages: [
        {
          id: "exhausted",
          objective: "must not be reclaimed forever",
          requiredContext: [],
          dependsOn: [],
        },
      ],
    });
    // Exercise reconciliation on this exact run. A generic queue claim can legitimately select
    // an older run left by another scenario in the same tenant and makes this assertion order-
    // dependent under the full suite.
    await database
      .update(factoryWorkflowRuns)
      .set({ status: "running", leaseOwner: "no-progress-worker" })
      .where(eq(factoryWorkflowRuns.id, run.id));
    await database
      .update(factoryWorkflowStages)
      .set({ attempts: 1, status: "pending" })
      .where(eq(factoryWorkflowStages.runId, run.id));

    expect(await runtime.readyStages(run.id)).toEqual([]);
    expect((await runtime.snapshot(run.id))?.run.status).toBe("failed");
  });

  test("a SIGKILLed worker on a one attempt run reaches a terminal state within two worker ticks", async () => {
    const queued = await store.queueJob("admin", {
      kind: "ci-repair",
      tier: "managed",
      objective: "terminate after a fatal crash",
      trigger: "two-tick-proof",
      minimumQuality: 0.8,
    });
    const run = await runtime.create({
      jobId: queued.job.id,
      maximumAttempts: 1,
      concurrencyLimit: 1,
      stages: [
        {
          id: "crash-stage",
          objective: "must not stay running forever",
          requiredContext: [],
          dependsOn: [],
        },
      ],
    });
    await isolateRun(run.id);
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

    const worker = createWorkflowWorker({
      runtime,
      workerId: "two-tick-worker",
      executor: {
        async execute() {
          throw new Error("A terminal run must not start its stage again.");
        },
        async review() {
          throw new Error("A terminal run must not reach review.");
        },
      },
    });

    let ticks = 0;
    let status = (await runtime.snapshot(run.id))?.run.status;
    while (ticks < 2 && status !== "failed" && status !== "succeeded") {
      await worker.runOnce();
      ticks += 1;
      status = (await runtime.snapshot(run.id))?.run.status;
    }
    expect({ status, ticks }).toEqual({ status: "failed", ticks: 1 });
    expect((await runtime.snapshot(run.id))?.stages[0]).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "Worker lease expired before a result was committed.",
    });
    await worker.drain();
  });

  /**
   * What this guarantees, and what it does not.
   *
   * It verifies **atomic observability**, not lexical placement. It reads through a
   * second connection, so it measures what another process can see — which is the
   * property issue #32 is about, since the bug is a worker picking up a stage that
   * is `pending` while still counted as having spent its attempt.
   *
   * #32's criterion 2 asks for a read "inside the same transaction as the reset".
   * That would measure what the *writer* sees, and a read inside the writing
   * transaction sees that transaction's own uncommitted writes. Reading from
   * outside is therefore the correct measurement rather than a workaround.
   *
   * The consequence worth knowing before you change `interruptStage`: an
   * implementation reaching the same guarantee another way — an advisory lock, a
   * serializable retry — would also pass this test. That is correct behaviourally.
   * Do not read it as pinning the refund statement's position inside a transaction
   * block; it pins the observable outcome, which is the thing callers depend on.
   */
  test("a concurrent reader never sees a reset stage still holding the attempt it was given back", async () => {
    // A second connection, so what it reads is what any other process would read
    // rather than anything this test's own connection is holding open.
    const observerDatabase = createDatabase(
      process.env.DATABASE_URL ??
        "postgres://openbot:openbot@localhost:5432/openbot",
      { max: 1 },
    );
    const queued = await store.queueJob("admin", {
      kind: "ci-repair",
      tier: "managed",
      objective: "hold the attempt and the status together",
      trigger: "atomic-refund-proof",
      minimumQuality: 0.8,
    });
    const run = await runtime.create({
      jobId: queued.job.id,
      maximumAttempts: 3,
      concurrencyLimit: 1,
      stages: [
        {
          id: "atomic",
          objective: "be reset atomically",
          requiredContext: [],
          dependsOn: [],
        },
      ],
    });
    await isolateRun(run.id);

    /** Every distinct `status:attempts` pair the stage row passes through. */
    const watch = () => {
      const seen = new Set<string>();
      let running = true;
      const loop = (async () => {
        while (running) {
          const [row] = await observerDatabase
            .select({
              status: factoryWorkflowStages.status,
              attempts: factoryWorkflowStages.attempts,
            })
            .from(factoryWorkflowStages)
            .where(eq(factoryWorkflowStages.runId, run.id));
          if (row) seen.add(`${row.status}:${row.attempts}`);
        }
      })();
      return {
        seen,
        /**
         * Keep watching until the reset has actually been observed, then stop.
         * Stopping the moment the write returns races the observer's in-flight
         * query, which can end the watch having sampled only the pre-reset row.
         */
        settle: async () => {
          const deadline = Date.now() + 5_000;
          while (
            Date.now() < deadline &&
            ![...seen].some((sample) => sample.startsWith("pending:"))
          )
            await Bun.sleep(5);
          running = false;
          await loop;
        },
      };
    };

    const holdOneAttempt = async (sessionId: string) => {
      await database
        .update(factoryWorkflowStages)
        .set({ status: "running", attempts: 1, sessionId })
        .where(eq(factoryWorkflowStages.runId, run.id));
    };

    // Positive control. Reset the status and give the attempt back as two
    // separate statements, which is what "outside the transaction" looks like.
    // If the observer cannot catch that, it cannot catch anything, and the
    // assertion below would pass for the wrong reason.
    await holdOneAttempt("control-session");
    const control = watch();
    await database
      .update(factoryWorkflowStages)
      .set({ status: "pending" })
      .where(eq(factoryWorkflowStages.runId, run.id));
    await Bun.sleep(50);
    await database
      .update(factoryWorkflowStages)
      .set({ attempts: 0 })
      .where(eq(factoryWorkflowStages.runId, run.id));
    await control.settle();
    expect([...control.seen]).toContain("pending:1");

    // The real path. Same observer, same stage, same starting point.
    await holdOneAttempt("live-session");
    const live = watch();
    await runtime.interruptStage(
      run.id,
      "atomic",
      "live-session",
      "Paused by an operator while running.",
    );
    await live.settle();

    // "pending:1" is a stage that has been handed back to the queue while still
    // counted as having spent the attempt. It is the state the issue describes,
    // and the control above proves this observer would have caught it.
    expect([...live.seen]).not.toContain("pending:1");
    expect([...live.seen]).toContain("pending:0");

    await runtime.requestAbort(run.id);
  });
});
