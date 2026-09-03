type WorkflowProjection = {
  run: { id: string; status: string };
};

const STREAMABLE_STATUSES = new Set(["queued", "running", "pausing"]);

/**
 * A queued run needs a stream before its worker claims it. Otherwise the UI has
 * no channel on which to learn about queued -> running, and a resumed run stays
 * visually queued until a manual reload. Terminal and paused history remains
 * disconnected so opening the page does not create streams for old runs.
 */
export function workflowStreamRunIds(
  workflows: readonly WorkflowProjection[],
): string[] {
  return workflows
    .filter(({ run }) => STREAMABLE_STATUSES.has(run.status))
    .map(({ run }) => run.id)
    .sort();
}
