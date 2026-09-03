import { describe, expect, test } from "bun:test";
import {
  publishWorkflowEvent,
  retainedWorkflowOutput,
  subscribeWorkflowEvents,
  WORKFLOW_OUTPUT_LIMIT,
} from "./workflow-stream";

describe("workflow push stream", () => {
  test("isolates simultaneous runs", () => {
    const a: string[] = [];
    const b: string[] = [];
    const stopA = subscribeWorkflowEvents("run-a", (event) =>
      a.push(String(event.payload.chunk)),
    );
    const stopB = subscribeWorkflowEvents("run-b", (event) =>
      b.push(String(event.payload.chunk)),
    );
    publishWorkflowEvent({
      runId: "run-a",
      type: "executor-output",
      payload: { chunk: "only-a" },
    });
    publishWorkflowEvent({
      runId: "run-b",
      type: "executor-output",
      payload: { chunk: "only-b" },
    });
    stopA();
    stopB();
    expect(a).toEqual(["only-a"]);
    expect(b).toEqual(["only-b"]);
  });

  test("retains only the last 64 KiB per stage", () => {
    publishWorkflowEvent({
      runId: "bounded-run",
      stageId: "execute",
      type: "check-output",
      payload: { chunk: `discard${"x".repeat(WORKFLOW_OUTPUT_LIMIT)}` },
    });
    const retained = retainedWorkflowOutput("bounded-run", "execute");
    expect(retained).toHaveLength(WORKFLOW_OUTPUT_LIMIT);
    expect(retained).not.toContain("discard");
  });
});
