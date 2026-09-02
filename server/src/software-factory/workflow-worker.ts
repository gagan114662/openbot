import { randomUUID } from "node:crypto";
import type { WorkflowRuntime } from "./workflow-runtime";

type Snapshot = NonNullable<Awaited<ReturnType<WorkflowRuntime["snapshot"]>>>;
type Stage = Snapshot["stages"][number];

export type StageCandidate = {
  sessionId: string;
  summary: string;
  artifacts: Array<{
    kind: string;
    uri: string;
    content: string;
    checksum: string;
    revision: string;
    producerSessionId: string;
    command?: string;
    exitCode?: number;
    metadata?: Record<string, unknown>;
  }>;
};

export class StageExecutionFailure extends Error {
  constructor(
    message: string,
    readonly artifacts: StageCandidate["artifacts"] = [],
  ) {
    super(message);
    this.name = "StageExecutionFailure";
  }
}

type RunInput = {
  runId: string;
  stage: Stage;
  snapshot: Snapshot;
  sessionId: string;
  signal: AbortSignal;
};
type ReviewInput = {
  runId: string;
  stage: Stage;
  snapshot: Snapshot;
  candidate: StageCandidate;
  sessionId: string;
  signal: AbortSignal;
};

export type WorkflowExecutor = {
  harness: "codex" | "claude" | "routed";
  run(input: RunInput): Promise<StageCandidate>;
  review(input: ReviewInput): Promise<{
    accepted: boolean;
    summary: string;
    checks: string[];
  }>;
  interrupt(): Promise<void>;
  cleanup?(runId: string): Promise<void>;
  sweep?(protectedRunIds: Set<string>): Promise<void>;
  worktreeStats?(): Promise<{ active: number; diskBytes: number }>;
};

export type WorkflowHarnessExecutor = WorkflowExecutor & {
  harness: "codex" | "claude";
};

export type WorkflowStageExecutor = {
  execute(input: RunInput): Promise<StageCandidate>;
  review(input: ReviewInput): Promise<{
    accepted: boolean;
    summary: string;
    checks: string[];
  }>;
};

/**
 * Executes one durable scheduling tick. The database is the queue: replicas race through the run
 * lease, stages are capped by the persisted concurrency limit, and a rejected/erroring candidate
 * returns to the same bounded attempt loop. The reviewer always receives a newly minted session id.
 */
export function createWorkflowWorker(options: {
  runtime: WorkflowRuntime;
  executor: WorkflowExecutor | WorkflowStageExecutor;
  workerId: string;
  sessionId?: () => string;
  leaseMs?: number;
  heartbeatMs?: number;
  stageTimeoutMs?: number;
  reviewAttempts?: number;
  onTerminalFailure?: (input: {
    runId: string;
    error: string;
  }) => Promise<void>;
}) {
  const sessionId = options.sessionId ?? randomUUID;
  const leaseMs = options.leaseMs ?? 30_000;
  const heartbeatMs = options.heartbeatMs ?? Math.max(250, leaseMs / 3);
  const stageTimeoutMs = options.stageTimeoutMs ?? 10 * 60_000;
  let draining = false;
  let swept = false;
  const active = new Set<Promise<void>>();
  const controllers = new Map<string, Set<AbortController>>();

  const executeStage = async (runId: string, stage: Stage) => {
    const workerSessionId = sessionId();
    const started = await options.runtime.startStage(
      runId,
      stage.stageId,
      workerSessionId,
    );
    if (!started) return;
    const controller = new AbortController();
    const runControllers = controllers.get(runId) ?? new Set<AbortController>();
    runControllers.add(controller);
    controllers.set(runId, runControllers);
    const deadline = setTimeout(
      () =>
        controller.abort(
          `Managed stage exceeded its ${stageTimeoutMs} ms execution deadline.`,
        ),
      stageTimeoutMs,
    );
    deadline.unref?.();
    const initialSnapshot = await options.runtime.snapshot(runId);
    const initialSteering =
      (initialSnapshot?.run.steering as { events?: unknown[] } | undefined)
        ?.events?.length ?? 0;
    const controlWatcher = setInterval(() => {
      void options.runtime.snapshot(runId).then((current) => {
        const steering =
          (current?.run.steering as { events?: unknown[] } | undefined)?.events
            ?.length ?? 0;
        if (
          !current ||
          current.run.abortRequested ||
          current.run.pauseRequested ||
          steering > initialSteering
        )
          controller.abort(
            "Workflow control changed while the stage was running.",
          );
      });
    }, 250);
    controlWatcher.unref?.();
    try {
      const snapshot = await options.runtime.snapshot(runId);
      if (!snapshot)
        throw new Error("Workflow disappeared after its stage was claimed.");
      const execute =
        "run" in options.executor
          ? options.executor.run.bind(options.executor)
          : options.executor.execute.bind(options.executor);
      const candidate = await execute({
        runId,
        stage: started,
        snapshot,
        sessionId: workerSessionId,
        signal: controller.signal,
      });
      if (candidate.sessionId !== workerSessionId)
        throw new Error(
          "Worker result was not produced by the claimed session.",
        );
      const reviewAttempts = Math.max(1, options.reviewAttempts ?? 2);
      let reviewerSessionId = "";
      let verification:
        | Awaited<ReturnType<WorkflowExecutor["review"]>>
        | undefined;
      let reviewError: unknown;
      for (let attempt = 0; attempt < reviewAttempts; attempt += 1) {
        reviewerSessionId = sessionId();
        if (reviewerSessionId === workerSessionId)
          throw new Error("Reviewer session id was not fresh.");
        try {
          verification = await options.executor.review({
            runId,
            stage: started,
            snapshot,
            candidate,
            sessionId: reviewerSessionId,
            signal: controller.signal,
          });
          break;
        } catch (error) {
          reviewError = error;
        }
      }
      if (!verification) throw reviewError;
      if (!verification.accepted)
        throw new Error(
          `Independent verification rejected the candidate: ${verification.summary}`,
        );
      await options.runtime.completeStage(runId, stage.stageId, {
        ...candidate,
        reviewerSessionId,
        verification: { ...verification, accepted: true as const },
      });
    } catch (error) {
      const current = await options.runtime.snapshot(runId);
      const steering =
        (current?.run.steering as { events?: unknown[] } | undefined)?.events
          ?.length ?? 0;
      if (current?.run.status === "aborted") return;
      if (current?.run.pauseRequested || steering > initialSteering) {
        await options.runtime.interruptStage(
          runId,
          stage.stageId,
          workerSessionId,
          current?.run.pauseRequested
            ? "Paused by an operator while running."
            : "Restarted to apply new operator steering.",
        );
      } else {
        const message = error instanceof Error ? error.message : String(error);
        const failure = await options.runtime.failStage(
          runId,
          stage.stageId,
          workerSessionId,
          message,
          error instanceof StageExecutionFailure
            ? error.artifacts.map((artifact) => ({
                ...artifact,
                metadata: artifact.metadata ?? {},
              }))
            : [],
        );
        if (failure?.terminal)
          await options.onTerminalFailure?.({ runId, error: message });
      }
    } finally {
      clearInterval(controlWatcher);
      clearTimeout(deadline);
      runControllers.delete(controller);
      if (runControllers.size === 0) controllers.delete(runId);
    }
  };

  return {
    async runOnce() {
      if (draining) return { claimed: false, stages: 0 };
      if (!swept && "sweep" in options.executor && options.executor.sweep) {
        await options.executor.sweep(
          new Set(await options.runtime.activeRunIds()),
        );
        swept = true;
      }
      const run = await options.runtime.claim(options.workerId, leaseMs);
      if (!run) return { claimed: false, stages: 0 };
      let renewing = false;
      const heartbeat = setInterval(() => {
        if (renewing) return;
        renewing = true;
        void options.runtime
          .renewLease(run.id, options.workerId, leaseMs)
          .then((renewed) => {
            if (!renewed)
              for (const controller of controllers.get(run.id) ?? [])
                controller.abort("Workflow lease ownership was lost.");
          })
          .catch(() => {
            for (const controller of controllers.get(run.id) ?? [])
              controller.abort("Workflow lease renewal failed.");
          })
          .finally(() => {
            renewing = false;
          });
      }, heartbeatMs);
      heartbeat.unref?.();
      const ready = await options.runtime.readyStages(run.id);
      const tasks = ready.map((stage) => {
        const task = executeStage(run.id, stage).finally(() =>
          active.delete(task),
        );
        active.add(task);
        return task;
      });
      await Promise.all(tasks).finally(() => clearInterval(heartbeat));
      const completed = await options.runtime.snapshot(run.id);
      if (
        completed &&
        ["awaiting_approval", "succeeded", "failed", "aborted"].includes(
          completed.run.status,
        )
      ) {
        if ("cleanup" in options.executor)
          await options.executor.cleanup?.(run.id);
      }
      return { claimed: true, stages: tasks.length, runId: run.id };
    },
    async drain() {
      draining = true;
      if ("interrupt" in options.executor) await options.executor.interrupt();
      await Promise.allSettled(active);
    },
    async worktreeStats() {
      return "worktreeStats" in options.executor &&
        options.executor.worktreeStats
        ? options.executor.worktreeStats()
        : { active: 0, diskBytes: 0 };
    },
  };
}

export type WorkflowWorker = ReturnType<typeof createWorkflowWorker>;
