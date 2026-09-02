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

export type WorkflowStageExecutor = {
  execute(input: {
    runId: string;
    stage: Stage;
    snapshot: Snapshot;
    sessionId: string;
    signal: AbortSignal;
  }): Promise<StageCandidate>;
  review(input: {
    runId: string;
    stage: Stage;
    snapshot: Snapshot;
    candidate: StageCandidate;
    sessionId: string;
    signal: AbortSignal;
  }): Promise<{ accepted: boolean; summary: string; checks: string[] }>;
};

/**
 * Executes one durable scheduling tick. The database is the queue: replicas race through the run
 * lease, stages are capped by the persisted concurrency limit, and a rejected/erroring candidate
 * returns to the same bounded attempt loop. The reviewer always receives a newly minted session id.
 */
export function createWorkflowWorker(options: {
  runtime: WorkflowRuntime;
  executor: WorkflowStageExecutor;
  workerId: string;
  sessionId?: () => string;
  onTerminalFailure?: (input: {
    runId: string;
    error: string;
  }) => Promise<void>;
}) {
  const sessionId = options.sessionId ?? randomUUID;
  let draining = false;
  const active = new Set<Promise<void>>();

  const executeStage = async (runId: string, stage: Stage) => {
    const workerSessionId = sessionId();
    const started = await options.runtime.startStage(
      runId,
      stage.stageId,
      workerSessionId,
    );
    if (!started) return;
    const controller = new AbortController();
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
      const candidate = await options.executor.execute({
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
      const reviewerSessionId = sessionId();
      if (reviewerSessionId === workerSessionId)
        throw new Error("Reviewer session id was not fresh.");
      const verification = await options.executor.review({
        runId,
        stage: started,
        snapshot,
        candidate,
        sessionId: reviewerSessionId,
        signal: controller.signal,
      });
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
          current?.run.pauseRequested
            ? "Paused by an operator while running."
            : "Restarted to apply new operator steering.",
        );
      } else {
        const message = error instanceof Error ? error.message : String(error);
        const failure = await options.runtime.failStage(
          runId,
          stage.stageId,
          message,
        );
        if (failure?.terminal)
          await options.onTerminalFailure?.({ runId, error: message });
      }
    } finally {
      clearInterval(controlWatcher);
    }
  };

  return {
    async runOnce() {
      if (draining) return { claimed: false, stages: 0 };
      const run = await options.runtime.claim(options.workerId);
      if (!run) return { claimed: false, stages: 0 };
      const ready = await options.runtime.readyStages(run.id);
      const tasks = ready.map((stage) => {
        const task = executeStage(run.id, stage).finally(() =>
          active.delete(task),
        );
        active.add(task);
        return task;
      });
      await Promise.all(tasks);
      return { claimed: true, stages: tasks.length, runId: run.id };
    },
    async drain() {
      draining = true;
      await Promise.allSettled(active);
    },
  };
}

export type WorkflowWorker = ReturnType<typeof createWorkflowWorker>;
