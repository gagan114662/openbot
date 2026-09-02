import type {
  WorkflowExecutor,
  WorkflowHarnessExecutor,
} from "./workflow-worker";

export function createRoutedWorkflowExecutor(
  executors: WorkflowHarnessExecutor[],
): WorkflowExecutor {
  const byHarness = new Map(
    executors.map((executor) => [executor.harness, executor]),
  );
  const resolve = (stage: { selectedHarness?: string | null }) => {
    const executor = byHarness.get(stage.selectedHarness as "codex" | "claude");
    if (!executor)
      throw new Error(
        `No workflow executor is configured for harness ${stage.selectedHarness ?? "missing"}.`,
      );
    return executor;
  };
  return {
    harness: "routed",
    run: (input) => resolve(input.stage).run(input),
    review: (input) => resolve(input.stage).review(input),
    async interrupt() {
      await Promise.all(executors.map((executor) => executor.interrupt()));
    },
    async cleanup(runId) {
      // Harnesses share one workspace manager/root. Calling every harness races two
      // `git worktree remove` processes against the same checkout.
      await executors[0]?.cleanup?.(runId);
    },
    async sweep(protectedRunIds) {
      await executors[0]?.sweep?.(protectedRunIds);
    },
    async worktreeStats() {
      return (
        (await executors[0]?.worktreeStats?.()) ?? {
          active: 0,
          diskBytes: 0,
        }
      );
    },
  };
}
