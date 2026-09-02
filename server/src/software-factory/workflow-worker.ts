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
  }): Promise<StageCandidate>;
  review(input: {
    runId: string;
    stage: Stage;
    snapshot: Snapshot;
    candidate: StageCandidate;
    sessionId: string;
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
    try {
      const snapshot = await options.runtime.snapshot(runId);
      if (!snapshot)
        throw new Error("Workflow disappeared after its stage was claimed.");
      const candidate = await options.executor.execute({
        runId,
        stage: started,
        snapshot,
        sessionId: workerSessionId,
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
      await options.runtime.failStage(
        runId,
        stage.stageId,
        error instanceof Error ? error.message : String(error),
      );
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
