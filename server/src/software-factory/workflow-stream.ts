export const WORKFLOW_OUTPUT_LIMIT = 64 * 1024;

export type WorkflowStreamEvent = {
  runId: string;
  type: "transition" | "check-output" | "executor-output" | "control";
  stageId?: string;
  payload: Record<string, unknown>;
  at: string;
};

const listeners = new Map<string, Set<(event: WorkflowStreamEvent) => void>>();
const output = new Map<string, string>();

const bufferKey = (runId: string, stageId?: string) =>
  `${runId}:${stageId ?? "run"}`;

export function publishWorkflowEvent(event: Omit<WorkflowStreamEvent, "at">) {
  const complete = { ...event, at: new Date().toISOString() };
  if (event.type === "check-output" || event.type === "executor-output") {
    const key = bufferKey(event.runId, event.stageId);
    const chunk = String(event.payload.chunk ?? "");
    output.set(
      key,
      `${output.get(key) ?? ""}${chunk}`.slice(-WORKFLOW_OUTPUT_LIMIT),
    );
  }
  for (const listener of listeners.get(event.runId) ?? []) listener(complete);
}

export function subscribeWorkflowEvents(
  runId: string,
  listener: (event: WorkflowStreamEvent) => void,
) {
  const runListeners = listeners.get(runId) ?? new Set();
  runListeners.add(listener);
  listeners.set(runId, runListeners);
  return () => {
    runListeners.delete(listener);
    if (runListeners.size === 0) listeners.delete(runId);
  };
}

export function retainedWorkflowOutput(runId: string, stageId?: string) {
  return output.get(bufferKey(runId, stageId)) ?? "";
}
