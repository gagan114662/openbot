import { expect, test } from "bun:test";
import { workflowStreamRunIds } from "./workflow-streams";

test("queued and resumed workflows stream their claim while historical runs stay disconnected", () => {
  expect(
    workflowStreamRunIds([
      { run: { id: "succeeded", status: "succeeded" } },
      { run: { id: "running", status: "running" } },
      { run: { id: "paused", status: "paused" } },
      { run: { id: "queued", status: "queued" } },
      { run: { id: "failed", status: "failed" } },
      { run: { id: "pausing", status: "pausing" } },
    ]),
  ).toEqual(["pausing", "queued", "running"]);
});
