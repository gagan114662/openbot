import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import {
  auditEvents,
  contextCompactionArtifacts,
  factoryManagedJobs,
  factoryWorkflowArtifacts,
  factoryWorkflowEvents,
  factoryWorkflowRuns,
  factoryWorkflowStages,
} from "../db/schema";

export const stageCheckSchema = z.object({
  id: z.string().trim().min(1).max(100),
  command: z.array(z.string().min(1).max(1_000)).min(1).max(50),
  cwd: z.string().trim().min(1).max(1_000).optional(),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(15 * 60_000),
  required: z.boolean(),
});

export const stagePlanSchema = z
  .array(
    z.object({
      id: z.string().trim().min(1).max(200),
      objective: z.string().trim().min(1).max(4_000),
      requiredContext: z.array(z.string().trim().min(1).max(500)).max(50),
      dependsOn: z.array(z.string().trim().min(1).max(200)).max(50),
      checks: z.array(stageCheckSchema).max(20).default([]),
      gate: z
        .object({
          kind: z.literal("human"),
          prompt: z.string().trim().min(1).max(4_000),
          roles: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
        })
        .optional(),
    }),
  )
  .min(1)
  .max(100);

export const stageResultSchema = z.object({
  summary: z.string().trim().min(1).max(20_000),
  sessionId: z.string().trim().min(1).max(500),
  reviewerSessionId: z.string().trim().min(1).max(500),
  verification: z.object({
    accepted: z.literal(true),
    summary: z.string().trim().min(1).max(20_000),
    checks: z.array(z.string().trim().min(1).max(4_000)).min(1).max(100),
  }),
  artifacts: z
    .array(
      z.object({
        kind: z.string().trim().min(1).max(100),
        uri: z.string().trim().min(1).max(4_000),
        content: z.string().max(1_000_000),
        checksum: z.string().regex(/^[a-f0-9]{64}$/),
        revision: z.string().trim().min(1).max(500),
        producerSessionId: z.string().trim().min(1).max(500),
        command: z.string().trim().max(10_000).optional(),
        exitCode: z.number().int().min(-1).max(255).optional(),
        metadata: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .min(1)
    .max(100),
});

const dependencyIds = (value: unknown) =>
  z.object({ ids: z.array(z.string()) }).parse(value).ids;

const stageControl = (value: unknown) =>
  z
    .object({
      items: z.array(stageCheckSchema).default([]),
      gate: z
        .object({
          kind: z.literal("human"),
          prompt: z.string(),
          roles: z.array(z.string()).optional(),
          status: z.enum(["pending", "approved"]).default("pending"),
          feedback: z.string().optional(),
        })
        .optional(),
    })
    .parse(value);

const assertDag = (stages: z.infer<typeof stagePlanSchema>) => {
  const ids = new Set(stages.map((stage) => stage.id));
  if (ids.size !== stages.length)
    throw new Error("Workflow stage ids must be unique.");
  for (const stage of stages) {
    if (
      stage.dependsOn.includes(stage.id) ||
      stage.dependsOn.some((id) => !ids.has(id))
    )
      throw new Error(`Workflow stage ${stage.id} has an invalid dependency.`);
  }
  const remaining = new Map(
    stages.map((stage) => [stage.id, new Set(stage.dependsOn)]),
  );
  while (remaining.size) {
    const ready = [...remaining].filter(
      ([, dependencies]) => dependencies.size === 0,
    );
    if (!ready.length)
      throw new Error("Workflow plan contains a dependency cycle.");
    for (const [id] of ready) {
      remaining.delete(id);
      for (const dependencies of remaining.values()) dependencies.delete(id);
    }
  }
};

export const artifactChecksum = (content: string | Uint8Array) =>
  createHash("sha256").update(content).digest("hex");

export function verifyWorkflowEvidence(snapshot: {
  run: { status: string; approvedBy: string | null };
  stages: Array<{
    stageId: string;
    status: string;
    sessionId: string | null;
    reviewerSessionId: string | null;
    verification: unknown;
  }>;
  artifacts: Array<{
    stageId: string;
    content: string;
    checksum: string;
    revision: string;
    producerSessionId: string;
    exitCode: number | null;
    metadata?: unknown;
  }>;
}) {
  const succeeded = snapshot.stages.filter(
    (stage) => stage.status === "succeeded",
  );
  const successfulArtifacts = snapshot.artifacts.filter((artifact) =>
    succeeded.some(
      (stage) =>
        stage.stageId === artifact.stageId &&
        stage.sessionId === artifact.producerSessionId,
    ),
  );
  const checks = {
    allStagesSucceeded:
      snapshot.stages.length > 0 && succeeded.length === snapshot.stages.length,
    artifactChecksums: snapshot.artifacts.every(
      (artifact) => artifactChecksum(artifact.content) === artifact.checksum,
    ),
    revisionBound: snapshot.artifacts.every((artifact) =>
      Boolean(artifact.revision.trim()),
    ),
    producerBound: snapshot.artifacts.every((artifact) => {
      const metadata = artifact.metadata as
        | { attemptStatus?: unknown }
        | null
        | undefined;
      return (
        successfulArtifacts.includes(artifact) ||
        metadata?.attemptStatus === "failed"
      );
    }),
    commandsSucceeded: successfulArtifacts.every(
      (artifact) => artifact.exitCode === 0,
    ),
    freshReviewers: succeeded.every(
      (stage) =>
        Boolean(stage.reviewerSessionId) &&
        stage.reviewerSessionId !== stage.sessionId,
    ),
    acceptedStages: succeeded.every(
      (stage) =>
        (stage.verification as { accepted?: unknown } | null)?.accepted ===
        true,
    ),
    artifactsForSucceededStages: succeeded.every((stage) =>
      snapshot.artifacts.some((artifact) => artifact.stageId === stage.stageId),
    ),
    humanApproval: Boolean(snapshot.run.approvedBy),
  };
  const terminal =
    snapshot.run.status === "succeeded" ||
    (snapshot.run.status === "awaiting_approval" && checks.allStagesSucceeded);
  const machineChecksPassed = Object.entries(checks).every(
    ([check, passed]) => check === "humanApproval" || passed,
  );
  return {
    terminal,
    readyForApproval:
      terminal &&
      snapshot.run.status === "awaiting_approval" &&
      machineChecksPassed,
    verified: terminal && Object.values(checks).every(Boolean),
    checks,
  };
}

export function createWorkflowRuntime(
  database: Database,
  tenantId: string,
  options: { failControlAudit?: () => Promise<never> } = {},
) {
  const controlAudit = async (
    tx: Parameters<Parameters<typeof database.transaction>[0]>[0],
    run: typeof factoryWorkflowRuns.$inferSelect,
    input?: {
      actorId: string;
      action: "approve" | "abort" | "pause" | "resume" | "steer";
      fromStatus: string;
      instructionHash?: string;
    },
  ) => {
    if (!input) return;
    if (options.failControlAudit) await options.failControlAudit();
    await tx.insert(auditEvents).values({
      eventType: "workflow.control_applied",
      targetType: "factory_workflow_run",
      targetId: run.id,
      actorUserId: input.actorId,
      payload: {
        action: input.action,
        jobId: run.jobId,
        fromStatus: input.fromStatus,
        toStatus: run.status,
        ...(input.instructionHash
          ? { instructionHash: input.instructionHash }
          : {}),
      },
    });
  };
  return {
    async activeRunIds() {
      const rows = await database
        .select({ id: factoryWorkflowRuns.id })
        .from(factoryWorkflowRuns)
        .where(
          and(
            eq(factoryWorkflowRuns.tenantId, tenantId),
            inArray(factoryWorkflowRuns.status, [
              "queued",
              "running",
              "paused",
              "pausing",
              "aborting",
            ]),
          ),
        );
      return rows.map((row) => row.id);
    },
    async listContextCapsules(limit = 50) {
      return database
        .select({
          id: contextCompactionArtifacts.id,
          runId: contextCompactionArtifacts.runId,
          threadId: contextCompactionArtifacts.threadId,
          checksum: contextCompactionArtifacts.checksum,
          createdAt: contextCompactionArtifacts.createdAt,
        })
        .from(contextCompactionArtifacts)
        .where(eq(contextCompactionArtifacts.tenantId, tenantId))
        .orderBy(asc(contextCompactionArtifacts.createdAt))
        .limit(Math.max(1, Math.min(100, limit)));
    },

    async contextCapsule(id: string) {
      const [artifact] = await database
        .select()
        .from(contextCompactionArtifacts)
        .where(
          and(
            eq(contextCompactionArtifacts.id, id),
            eq(contextCompactionArtifacts.tenantId, tenantId),
          ),
        );
      return artifact ?? null;
    },

    async list(limit = 50) {
      const runs = await database
        .select()
        .from(factoryWorkflowRuns)
        .where(eq(factoryWorkflowRuns.tenantId, tenantId))
        .orderBy(asc(factoryWorkflowRuns.createdAt))
        .limit(Math.max(1, Math.min(100, limit)));
      if (runs.length === 0) return [];
      const runIds = runs.map((run) => run.id);
      // Keep dashboard load constant-query. The previous per-run fan-out issued as many as 301
      // queries and crossed the HTTP idle timeout once real execution history accumulated.
      const [stages, artifacts, events] = await Promise.all([
        database
          .select()
          .from(factoryWorkflowStages)
          .where(inArray(factoryWorkflowStages.runId, runIds))
          .orderBy(
            asc(factoryWorkflowStages.runId),
            asc(factoryWorkflowStages.stageId),
          ),
        database
          .select()
          .from(factoryWorkflowArtifacts)
          .where(inArray(factoryWorkflowArtifacts.runId, runIds))
          .orderBy(
            asc(factoryWorkflowArtifacts.runId),
            asc(factoryWorkflowArtifacts.createdAt),
          ),
        database
          .select()
          .from(factoryWorkflowEvents)
          .where(inArray(factoryWorkflowEvents.runId, runIds))
          .orderBy(
            asc(factoryWorkflowEvents.runId),
            asc(factoryWorkflowEvents.createdAt),
          ),
      ]);
      return runs.map((run) => {
        const snapshot = {
          run,
          stages: stages.filter((stage) => stage.runId === run.id),
          artifacts: artifacts.filter((artifact) => artifact.runId === run.id),
          events: events.filter((event) => event.runId === run.id),
        };
        return { ...snapshot, evidence: verifyWorkflowEvidence(snapshot) };
      });
    },

    async create(input: {
      jobId: string;
      maximumAttempts: number;
      concurrencyLimit: number;
      stages: unknown;
    }) {
      const stages = stagePlanSchema.parse(input.stages);
      assertDag(stages);
      if (
        !Number.isSafeInteger(input.maximumAttempts) ||
        input.maximumAttempts < 1 ||
        input.maximumAttempts > 5
      )
        throw new Error("Workflow attempts must be between one and five.");
      if (
        !Number.isSafeInteger(input.concurrencyLimit) ||
        input.concurrencyLimit < 1 ||
        input.concurrencyLimit > 16
      )
        throw new Error(
          "Workflow concurrency must be between one and sixteen.",
        );
      return database.transaction(async (tx) => {
        const [job] = await tx
          .select({
            selectedModel: factoryManagedJobs.selectedModel,
            selectedHarness: factoryManagedJobs.selectedHarness,
          })
          .from(factoryManagedJobs)
          .where(
            and(
              eq(factoryManagedJobs.id, input.jobId),
              eq(factoryManagedJobs.tenantId, tenantId),
            ),
          );
        if (!job?.selectedModel || !job.selectedHarness)
          throw new Error("Workflow job has no benchmarked harness route.");
        const [run] = await tx
          .insert(factoryWorkflowRuns)
          .values({
            tenantId,
            jobId: input.jobId,
            maximumAttempts: input.maximumAttempts,
            concurrencyLimit: input.concurrencyLimit,
          })
          .onConflictDoNothing()
          .returning();
        if (!run) {
          const [existing] = await tx
            .select()
            .from(factoryWorkflowRuns)
            .where(
              and(
                eq(factoryWorkflowRuns.tenantId, tenantId),
                eq(factoryWorkflowRuns.jobId, input.jobId),
              ),
            );
          if (!existing)
            throw new Error("Workflow creation lost its idempotency race.");
          return existing;
        }
        await tx.insert(factoryWorkflowStages).values(
          stages.map((stage) => ({
            runId: run.id,
            stageId: stage.id,
            objective: stage.objective,
            requiredContext: { keys: stage.requiredContext },
            dependsOn: { ids: stage.dependsOn },
            checks: { items: stage.checks },
            ...(stage.gate
              ? {
                  checks: {
                    items: stage.checks,
                    gate: { ...stage.gate, status: "pending" as const },
                  },
                }
              : {}),
            selectedModel: job.selectedModel,
            selectedHarness: job.selectedHarness,
          })),
        );
        return run;
      });
    },

    async snapshot(runId: string) {
      const [run] = await database
        .select()
        .from(factoryWorkflowRuns)
        .where(
          and(
            eq(factoryWorkflowRuns.id, runId),
            eq(factoryWorkflowRuns.tenantId, tenantId),
          ),
        );
      if (!run) return null;
      const [stages, artifacts, events] = await Promise.all([
        database
          .select()
          .from(factoryWorkflowStages)
          .where(eq(factoryWorkflowStages.runId, runId))
          .orderBy(asc(factoryWorkflowStages.stageId)),
        database
          .select()
          .from(factoryWorkflowArtifacts)
          .where(eq(factoryWorkflowArtifacts.runId, runId))
          .orderBy(asc(factoryWorkflowArtifacts.createdAt)),
        database
          .select()
          .from(factoryWorkflowEvents)
          .where(eq(factoryWorkflowEvents.runId, runId))
          .orderBy(asc(factoryWorkflowEvents.createdAt)),
      ]);
      const snapshot = { run, stages, artifacts, events };
      return { ...snapshot, evidence: verifyWorkflowEvidence(snapshot) };
    },

    async control(runId: string) {
      const [run] = await database
        .select({
          status: factoryWorkflowRuns.status,
          pauseRequested: factoryWorkflowRuns.pauseRequested,
          abortRequested: factoryWorkflowRuns.abortRequested,
          steering: factoryWorkflowRuns.steering,
        })
        .from(factoryWorkflowRuns)
        .where(
          and(
            eq(factoryWorkflowRuns.id, runId),
            eq(factoryWorkflowRuns.tenantId, tenantId),
          ),
        );
      return run ?? null;
    },

    async recordReviewRetry(
      runId: string,
      stageId: string,
      reviewerSessionId: string,
      error: unknown,
    ) {
      const message = error instanceof Error ? error.message : String(error);
      const [event] = await database
        .insert(factoryWorkflowEvents)
        .values({
          runId,
          stageId,
          entity: "reviewer",
          fromStatus: "malformed_output",
          toStatus: "retrying",
          detail: {
            reviewerSessionId,
            errorName: error instanceof Error ? error.name : "Error",
            error: message.slice(0, 2_000),
          },
        })
        .returning();
      return event;
    },

    async decideStageGate(
      runId: string,
      stageId: string,
      actorId: string,
      decision: "approve" | "reject",
      feedback?: string,
    ) {
      return database.transaction(async (tx) => {
        const [stage] = await tx
          .select()
          .from(factoryWorkflowStages)
          .where(
            and(
              eq(factoryWorkflowStages.runId, runId),
              eq(factoryWorkflowStages.stageId, stageId),
              eq(factoryWorkflowStages.status, "awaiting_approval"),
            ),
          )
          .for("update");
        if (!stage) return null;
        const control = stageControl(stage.checks);
        if (!control.gate) return null;
        const now = new Date();
        if (decision === "reject") {
          const text = feedback?.trim();
          if (!text) throw new Error("Gate rejection requires feedback.");
          const producers = dependencyIds(stage.dependsOn);
          await tx
            .update(factoryWorkflowStages)
            .set({
              status: "pending",
              completedAt: null,
              reviewerSessionId: null,
              verification: {},
              lastError: `Human gate feedback: ${text}`,
              updatedAt: now,
            })
            .where(
              and(
                eq(factoryWorkflowStages.runId, runId),
                inArray(factoryWorkflowStages.stageId, producers),
                eq(factoryWorkflowStages.status, "succeeded"),
              ),
            );
          await tx
            .update(factoryWorkflowArtifacts)
            .set({
              metadata: sql`coalesce(${factoryWorkflowArtifacts.metadata}, '{}'::jsonb) || ${JSON.stringify({ attemptStatus: "failed", gateRejected: true })}::jsonb`,
            })
            .where(
              and(
                eq(factoryWorkflowArtifacts.runId, runId),
                inArray(factoryWorkflowArtifacts.stageId, producers),
              ),
            );
        }
        await tx
          .update(factoryWorkflowStages)
          .set({
            status: "pending",
            checks: {
              ...control,
              gate: {
                ...control.gate,
                status: decision === "approve" ? "approved" : "pending",
                ...(feedback ? { feedback: feedback.trim() } : {}),
              },
            },
            updatedAt: now,
          })
          .where(
            and(
              eq(factoryWorkflowStages.runId, runId),
              eq(factoryWorkflowStages.stageId, stageId),
            ),
          );
        await tx.insert(factoryWorkflowEvents).values({
          runId,
          stageId,
          entity: "human_gate",
          fromStatus: "awaiting_approval",
          toStatus: decision === "approve" ? "approved" : "rejected",
          detail: { actorId, feedback: feedback?.trim() ?? null },
        });
        await tx
          .update(factoryWorkflowRuns)
          .set({
            status: "queued",
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: now,
          })
          .where(eq(factoryWorkflowRuns.id, runId));
        return { stageId, decision };
      });
    },

    async requestPause(
      runId: string,
      audit?: { actorId: string; fromStatus: string },
    ) {
      return database.transaction(async (tx) => {
        const [run] = await tx
          .update(factoryWorkflowRuns)
          .set({
            pauseRequested: true,
            status: "pausing",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(factoryWorkflowRuns.id, runId),
              eq(factoryWorkflowRuns.tenantId, tenantId),
              inArray(factoryWorkflowRuns.status, ["queued", "running"]),
            ),
          )
          .returning();
        if (run && audit)
          await controlAudit(tx, run, {
            ...audit,
            action: "pause",
          });
        return run
          ? Object.assign(run, audit ? { controlAuditPersisted: true } : {})
          : null;
      });
    },

    async resume(
      runId: string,
      audit?: { actorId: string; fromStatus: string },
    ) {
      return database.transaction(async (tx) => {
        const [run] = await tx
          .update(factoryWorkflowRuns)
          .set({
            pauseRequested: false,
            status: "queued",
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(factoryWorkflowRuns.id, runId),
              eq(factoryWorkflowRuns.tenantId, tenantId),
              inArray(factoryWorkflowRuns.status, ["paused", "pausing"]),
            ),
          )
          .returning();
        if (run && audit)
          await controlAudit(tx, run, { ...audit, action: "resume" });
        return run
          ? Object.assign(run, audit ? { controlAuditPersisted: true } : {})
          : null;
      });
    },

    async requestAbort(
      runId: string,
      audit?: { actorId: string; fromStatus: string },
    ) {
      const now = new Date();
      return database.transaction(async (tx) => {
        const [run] = await tx
          .update(factoryWorkflowRuns)
          .set({
            abortRequested: true,
            status: "aborted",
            completedAt: now,
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(factoryWorkflowRuns.id, runId),
              eq(factoryWorkflowRuns.tenantId, tenantId),
              inArray(factoryWorkflowRuns.status, [
                "queued",
                "running",
                "paused",
                "pausing",
                "awaiting_approval",
              ]),
            ),
          )
          .returning();
        if (run && audit)
          await tx
            .update(factoryWorkflowStages)
            .set({ status: "aborted", updatedAt: now })
            .where(
              and(
                eq(factoryWorkflowStages.runId, runId),
                inArray(factoryWorkflowStages.status, ["pending", "running"]),
              ),
            );
        if (run && audit)
          await controlAudit(tx, run, { ...audit, action: "abort" });
        return run
          ? Object.assign(run, audit ? { controlAuditPersisted: true } : {})
          : null;
      });
    },

    async steer(
      runId: string,
      actorId: string,
      instruction: string,
      audit?: { fromStatus: string; instructionHash: string },
    ) {
      const text = instruction.trim();
      if (!text || text.length > 4_000)
        throw new Error(
          "Steering instruction must contain 1-4,000 characters.",
        );
      return database.transaction(async (tx) => {
        const [run] = await tx
          .update(factoryWorkflowRuns)
          .set({
            steering: sql`jsonb_set(coalesce(${factoryWorkflowRuns.steering}, '{"events":[]}'::jsonb), '{events}', coalesce(${factoryWorkflowRuns.steering}->'events', '[]'::jsonb) || ${JSON.stringify([{ actorId, instruction: text, at: new Date().toISOString() }])}::jsonb)`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(factoryWorkflowRuns.id, runId),
              eq(factoryWorkflowRuns.tenantId, tenantId),
              inArray(factoryWorkflowRuns.status, [
                "queued",
                "running",
                "paused",
                "pausing",
              ]),
            ),
          )
          .returning();
        if (run && audit)
          await controlAudit(tx, run, {
            actorId,
            action: "steer",
            ...audit,
          });
        return run
          ? Object.assign(run, audit ? { controlAuditPersisted: true } : {})
          : null;
      });
    },

    async approve(
      runId: string,
      actorId: string,
      audit?: { fromStatus: string },
    ) {
      return database.transaction(async (tx) => {
        const [run] = await tx
          .update(factoryWorkflowRuns)
          .set({
            approvedBy: actorId,
            status: "succeeded",
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(factoryWorkflowRuns.id, runId),
              eq(factoryWorkflowRuns.tenantId, tenantId),
              eq(factoryWorkflowRuns.status, "awaiting_approval"),
            ),
          )
          .returning();
        if (run && audit)
          await controlAudit(tx, run, {
            actorId,
            action: "approve",
            ...audit,
          });
        return run
          ? Object.assign(run, audit ? { controlAuditPersisted: true } : {})
          : null;
      });
    },

    async claim(workerId: string, leaseMs = 30_000) {
      const now = new Date();
      const expires = new Date(now.valueOf() + leaseMs);
      return database.transaction(async (tx) => {
        const [run] = await tx
          .select()
          .from(factoryWorkflowRuns)
          .where(
            and(
              eq(factoryWorkflowRuns.tenantId, tenantId),
              inArray(factoryWorkflowRuns.status, [
                "queued",
                "running",
                "pausing",
              ]),
              eq(factoryWorkflowRuns.abortRequested, false),
              or(
                isNull(factoryWorkflowRuns.leaseExpiresAt),
                lt(factoryWorkflowRuns.leaseExpiresAt, now),
                eq(factoryWorkflowRuns.leaseOwner, workerId),
              ),
            ),
          )
          .orderBy(asc(factoryWorkflowRuns.createdAt))
          .limit(1)
          .for("update", { skipLocked: true });
        if (!run) return null;
        if (run.leaseExpiresAt && run.leaseExpiresAt < now) {
          // The prior process died after starting work. Its uncommitted stage has no trustworthy
          // completion artifact, so make that same bounded attempt runnable again. The attempt is
          // not refunded: repeated crashes still reach the configured terminal stop.
          const expiredStages = await tx
            .select()
            .from(factoryWorkflowStages)
            .where(
              and(
                eq(factoryWorkflowStages.runId, run.id),
                eq(factoryWorkflowStages.status, "running"),
              ),
            );
          const exhausted = expiredStages.some(
            (stage) => stage.attempts >= run.maximumAttempts,
          );
          await tx
            .update(factoryWorkflowStages)
            .set({
              status: exhausted ? "failed" : "pending",
              sessionId: null,
              lastError: "Worker lease expired before a result was committed.",
              updatedAt: now,
            })
            .where(
              and(
                eq(factoryWorkflowStages.runId, run.id),
                eq(factoryWorkflowStages.status, "running"),
              ),
            );
          if (exhausted) {
            await tx
              .update(factoryWorkflowRuns)
              .set({
                status: "failed",
                completedAt: now,
                leaseOwner: null,
                leaseExpiresAt: null,
                updatedAt: now,
              })
              .where(eq(factoryWorkflowRuns.id, run.id));
            return null;
          }
        }
        if (run.pauseRequested) {
          await tx
            .update(factoryWorkflowRuns)
            .set({
              status: "paused",
              leaseOwner: null,
              leaseExpiresAt: null,
              updatedAt: now,
            })
            .where(eq(factoryWorkflowRuns.id, run.id));
          return null;
        }
        const [claimed] = await tx
          .update(factoryWorkflowRuns)
          .set({
            status: "running",
            leaseOwner: workerId,
            leaseExpiresAt: expires,
            startedAt: run.startedAt ?? now,
            updatedAt: now,
          })
          .where(eq(factoryWorkflowRuns.id, run.id))
          .returning();
        return claimed ?? null;
      });
    },

    async renewLease(runId: string, workerId: string, leaseMs = 30_000) {
      const [run] = await database
        .update(factoryWorkflowRuns)
        .set({
          leaseExpiresAt: new Date(Date.now() + leaseMs),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(factoryWorkflowRuns.id, runId),
            eq(factoryWorkflowRuns.tenantId, tenantId),
            eq(factoryWorkflowRuns.status, "running"),
            eq(factoryWorkflowRuns.leaseOwner, workerId),
          ),
        )
        .returning({ id: factoryWorkflowRuns.id });
      return Boolean(run);
    },

    async readyStages(runId: string) {
      const snapshot = await this.snapshot(runId);
      if (snapshot?.run.status !== "running") return [];
      const completed = new Set(
        snapshot.stages
          .filter((stage) => stage.status === "succeeded")
          .map((stage) => stage.stageId),
      );
      const running = snapshot.stages.filter(
        (stage) => stage.status === "running",
      ).length;
      const available = Math.max(0, snapshot.run.concurrencyLimit - running);
      const eligible = snapshot.stages.filter(
        (stage) =>
          stage.status === "pending" &&
          stage.attempts < snapshot.run.maximumAttempts &&
          dependencyIds(stage.dependsOn).every((dependency) =>
            completed.has(dependency),
          ),
      );
      const gated = eligible.filter((stage) => {
        const gate = stageControl(stage.checks).gate;
        return gate && gate.status !== "approved";
      });
      if (gated.length) {
        await database.transaction(async (tx) => {
          for (const stage of gated) {
            await tx
              .update(factoryWorkflowStages)
              .set({ status: "awaiting_approval", updatedAt: new Date() })
              .where(
                and(
                  eq(factoryWorkflowStages.runId, runId),
                  eq(factoryWorkflowStages.stageId, stage.stageId),
                  eq(factoryWorkflowStages.status, "pending"),
                ),
              );
            await tx.insert(factoryWorkflowEvents).values({
              runId,
              stageId: stage.stageId,
              entity: "human_gate",
              fromStatus: "pending",
              toStatus: "awaiting_approval",
              detail: { gate: stageControl(stage.checks).gate },
            });
          }
        });
      }
      const runnable = eligible
        .filter((stage) => !gated.includes(stage))
        .slice(0, available);
      if (
        runnable.length === 0 &&
        (gated.length > 0 ||
          snapshot.stages.some((stage) => stage.status === "awaiting_approval"))
      ) {
        await database
          .update(factoryWorkflowRuns)
          .set({
            status: "awaiting_approval",
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(factoryWorkflowRuns.id, runId),
              eq(factoryWorkflowRuns.status, "running"),
            ),
          );
      }
      return runnable;
    },

    async startStage(runId: string, stageId: string, sessionId: string) {
      const [run] = await database
        .select()
        .from(factoryWorkflowRuns)
        .where(
          and(
            eq(factoryWorkflowRuns.id, runId),
            eq(factoryWorkflowRuns.tenantId, tenantId),
          ),
        );
      if (run?.status !== "running" || run.pauseRequested || run.abortRequested)
        return null;
      const [stage] = await database
        .update(factoryWorkflowStages)
        .set({
          status: "running",
          attempts: sql`${factoryWorkflowStages.attempts} + 1`,
          sessionId,
          startedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(factoryWorkflowStages.runId, runId),
            eq(factoryWorkflowStages.stageId, stageId),
            eq(factoryWorkflowStages.status, "pending"),
            lt(factoryWorkflowStages.attempts, run.maximumAttempts),
          ),
        )
        .returning();
      return stage ?? null;
    },

    async completeStage(runId: string, stageId: string, raw: unknown) {
      const result = stageResultSchema.parse(raw);
      if (result.sessionId === result.reviewerSessionId)
        throw new Error(
          "A stage must be verified in a fresh reviewer session.",
        );
      for (const artifact of result.artifacts) {
        if (artifact.producerSessionId !== result.sessionId)
          throw new Error(
            "Artifact producer provenance does not match the worker session.",
          );
        if (artifactChecksum(artifact.content) !== artifact.checksum)
          throw new Error(
            "Artifact checksum does not match its retrievable content.",
          );
      }
      return database.transaction(async (tx) => {
        const [stage] = await tx
          .update(factoryWorkflowStages)
          .set({
            status: "succeeded",
            output: { summary: result.summary },
            sessionId: result.sessionId,
            reviewerSessionId: result.reviewerSessionId,
            verification: result.verification,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(factoryWorkflowStages.runId, runId),
              eq(factoryWorkflowStages.stageId, stageId),
              eq(factoryWorkflowStages.status, "running"),
              eq(factoryWorkflowStages.sessionId, result.sessionId),
            ),
          )
          .returning();
        if (!stage) throw new Error("Running workflow stage was not found.");
        await tx
          .insert(factoryWorkflowArtifacts)
          .values(
            result.artifacts.map((artifact) => ({
              runId,
              stageId,
              ...artifact,
            })),
          )
          .onConflictDoNothing();
        const remaining = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(factoryWorkflowStages)
          .where(
            and(
              eq(factoryWorkflowStages.runId, runId),
              inArray(factoryWorkflowStages.status, ["pending", "running"]),
            ),
          );
        if ((remaining[0]?.count ?? 0) === 0)
          await tx
            .update(factoryWorkflowRuns)
            .set({
              status: "awaiting_approval",
              leaseOwner: null,
              leaseExpiresAt: null,
              updatedAt: new Date(),
            })
            .where(eq(factoryWorkflowRuns.id, runId));
        return stage;
      });
    },

    async failStage(
      runId: string,
      stageId: string,
      sessionId: string,
      error: string,
      artifacts: z.infer<typeof stageResultSchema>["artifacts"] = [],
    ) {
      return database.transaction(async (tx) => {
        const [run] = await tx
          .select()
          .from(factoryWorkflowRuns)
          .where(
            and(
              eq(factoryWorkflowRuns.id, runId),
              eq(factoryWorkflowRuns.tenantId, tenantId),
            ),
          )
          .for("update");
        const [stage] = await tx
          .select()
          .from(factoryWorkflowStages)
          .where(
            and(
              eq(factoryWorkflowStages.runId, runId),
              eq(factoryWorkflowStages.stageId, stageId),
            ),
          )
          .for("update");
        if (
          !run ||
          !stage ||
          stage.status !== "running" ||
          stage.sessionId !== sessionId
        )
          return null;
        const checkedArtifacts = artifacts.length
          ? stageResultSchema.shape.artifacts.parse(artifacts)
          : [];
        if (
          checkedArtifacts.some(
            (artifact) => artifact.producerSessionId !== sessionId,
          )
        )
          throw new Error("Failed-attempt evidence has the wrong producer.");
        if (checkedArtifacts.length > 0)
          await tx
            .insert(factoryWorkflowArtifacts)
            .values(
              checkedArtifacts.map((artifact) => ({
                runId,
                stageId,
                ...artifact,
              })),
            )
            .onConflictDoNothing();
        const terminal = stage.attempts >= run.maximumAttempts;
        await tx
          .update(factoryWorkflowStages)
          .set({
            status: terminal ? "failed" : "pending",
            lastError: error.slice(0, 4_000),
            sessionId: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(factoryWorkflowStages.runId, runId),
              eq(factoryWorkflowStages.stageId, stageId),
              eq(factoryWorkflowStages.sessionId, sessionId),
            ),
          );
        if (terminal)
          await tx
            .update(factoryWorkflowRuns)
            .set({
              status: "failed",
              completedAt: new Date(),
              leaseOwner: null,
              leaseExpiresAt: null,
              updatedAt: new Date(),
            })
            .where(eq(factoryWorkflowRuns.id, runId));
        return { terminal, attempts: stage.attempts };
      });
    },

    async interruptStage(
      runId: string,
      stageId: string,
      sessionId: string,
      reason: string,
    ) {
      const [stage] = await database
        .update(factoryWorkflowStages)
        .set({
          status: "pending",
          attempts: sql`greatest(${factoryWorkflowStages.attempts} - 1, 0)`,
          sessionId: null,
          lastError: reason.slice(0, 4_000),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(factoryWorkflowStages.runId, runId),
            eq(factoryWorkflowStages.stageId, stageId),
            eq(factoryWorkflowStages.status, "running"),
            eq(factoryWorkflowStages.sessionId, sessionId),
          ),
        )
        .returning();
      return stage ?? null;
    },
  };
}

export type WorkflowRuntime = ReturnType<typeof createWorkflowRuntime>;
