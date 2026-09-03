import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  auditEvents,
  factoryManagedJobs,
  factoryModelBenchmarks,
  factoryWorkflowArtifacts,
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
      expect(snapshot?.artifacts.map((artifact) => artifact.kind)).toEqual([
        "codex-stage-result",
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
    const gateAudits = await database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.targetId, run.id));
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

  test("same-owner crash recovery resets an expired stage and stale sessions cannot mutate it", async () => {
    const queued = await store.queueJob("admin", {
      kind: "ci-repair",
      tier: "managed",
      objective: "bind writes to the live session",
      trigger: "session-race-proof",
      minimumQuality: 0.8,
    });
    const run = await runtime.create({
      jobId: queued.job.id,
      maximumAttempts: 2,
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
    expect((await runtime.claim("same-host", 20))?.id).toBe(run.id);
    expect(
      await runtime.startStage(run.id, "owned", "stale-session"),
    ).not.toBeNull();
    await Bun.sleep(30);
    expect((await runtime.claim("same-host", 1_000))?.id).toBe(run.id);
    expect((await runtime.snapshot(run.id))?.stages[0]).toMatchObject({
      status: "pending",
      attempts: 1,
    });
    expect(
      await runtime.startStage(run.id, "owned", "live-session"),
    ).not.toBeNull();
    expect(
      await runtime.failStage(run.id, "owned", "stale-session", "late failure"),
    ).toBeNull();
    expect(
      await runtime.interruptStage(
        run.id,
        "owned",
        "stale-session",
        "late interrupt",
      ),
    ).toBeNull();
    const content = "live result";
    await runtime.completeStage(run.id, "owned", {
      summary: content,
      sessionId: "live-session",
      reviewerSessionId: "fresh-reviewer",
      verification: {
        accepted: true,
        summary: "session ownership verified",
        checks: ["race test"],
      },
      artifacts: [
        {
          kind: "race-proof",
          uri: `workflow://${run.id}/race`,
          content,
          checksum: artifactChecksum(content),
          revision: "deadbeef",
          producerSessionId: "live-session",
          command: "bun test",
          exitCode: 0,
        },
      ],
    });
    expect((await runtime.snapshot(run.id))?.run.status).toBe(
      "awaiting_approval",
    );
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
    await runtime.claim("no-progress-worker");
    await database
      .update(factoryWorkflowStages)
      .set({ attempts: 1, status: "pending" })
      .where(eq(factoryWorkflowStages.runId, run.id));

    expect(await runtime.readyStages(run.id)).toEqual([]);
    expect((await runtime.snapshot(run.id))?.run.status).toBe("failed");
  });
});
