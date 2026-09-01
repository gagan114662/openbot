import { describe, expect, test } from "bun:test";
import { AdapterOperations } from "./operations";

describe("tenant budgets and SLO metrics", () => {
  test("enforces daily and concurrent run limits", async () => {
    const operations = new AdapterOperations(1, 1);
    const first = await operations.begin();
    expect("startedAt" in first).toBe(true);
    expect(await operations.begin()).toEqual({
      refused: "The tenant concurrency limit of 1 runs is active.",
    });
    if ("startedAt" in first) operations.finish(first, true);
    expect(await operations.begin()).toEqual({
      refused: "The tenant daily budget of 1 runs is exhausted.",
    });
  });

  test("exports counters without tenant content or credentials", async () => {
    const operations = new AdapterOperations(10, 2, undefined, "tenant-a");
    const permit = await operations.begin();
    if ("startedAt" in permit) operations.finish(permit, false);
    operations.recordToolCall(true);
    const metrics = operations.prometheus();
    expect(metrics).toContain(
      'openbot_codex_run_errors_total{deployment="tenant-a"} 1',
    );
    expect(metrics).toContain(
      'openbot_codex_refusals_total{deployment="tenant-a"} 1',
    );
    expect(metrics).toContain(
      'openbot_codex_run_duration_milliseconds_bucket{deployment="tenant-a",le="+Inf"} 1',
    );
    expect(metrics).not.toContain("token");
  });
});
