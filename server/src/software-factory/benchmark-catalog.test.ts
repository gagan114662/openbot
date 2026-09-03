import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factoryBenchmarkCatalog } from "./benchmark-catalog";

test("the unchanged-tree negative control fails before any benchmark worker runs", async () => {
  const task = factoryBenchmarkCatalog["ci-repair-v1"];
  const check = task.checks.find(
    ({ id }) => id === "observable-change-negative-control",
  );
  expect(check).toBeDefined();
  expect(task.objective).not.toContain(check?.command.at(-1));
  const emptyCheckout = await mkdtemp(
    join(tmpdir(), "openbot-negative-control-"),
  );
  try {
    const result = Bun.spawnSync([...check!.command], { cwd: emptyCheckout });
    expect(result.exitCode).not.toBe(0);
  } finally {
    await rm(emptyCheckout, { recursive: true, force: true });
  }
});
