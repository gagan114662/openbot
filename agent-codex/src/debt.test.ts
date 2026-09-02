import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessTechnicalDebt, changedPaths } from "./debt";

describe("artifact technical-debt gate", () => {
  test("measures files actually produced after the run and refuses excess debt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-debt-"));
    try {
      const git = (args: string[]) =>
        Bun.spawnSync(["git", ...args], { cwd: directory }).exitCode;
      expect(git(["init", "-q"])).toBe(0);
      const before = await changedPaths(directory);
      await Bun.write(
        join(directory, "new.ts"),
        "export function risky(x: boolean) {\n  if (x) return 1;\n  if (x) return 1;\n}\n",
      );
      const result = await assessTechnicalDebt({
        cwd: directory,
        before,
        budget: {
          addedDependencies: 0,
          complexityPoints: 1,
          duplicatedLines: 0,
          maximumFileLines: 20,
        },
      });
      expect(result.changedPaths).toEqual(["new.ts"]);
      expect(result.metrics.complexityPoints).toBe(2);
      expect(result.violations).toContain("complexityPoints 2 exceeds 1");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not charge a bounded edit for debt already present at HEAD", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-debt-baseline-"));
    try {
      const git = (args: string[]) =>
        Bun.spawnSync(["git", ...args], { cwd: directory }).exitCode;
      expect(git(["init", "-q"])).toBe(0);
      expect(git(["config", "user.email", "test@openbot.local"])).toBe(0);
      expect(git(["config", "user.name", "OpenBot Test"])).toBe(0);
      await Bun.write(
        join(directory, "legacy.ts"),
        Array.from({ length: 900 }, (_, index) => `export const value${index} = ${index};`).join("\n"),
      );
      expect(git(["add", "legacy.ts"])).toBe(0);
      expect(git(["commit", "-qm", "baseline"])).toBe(0);
      const before = await changedPaths(directory);
      await Bun.write(
        join(directory, "legacy.ts"),
        `${await Bun.file(join(directory, "legacy.ts")).text()}\nexport const boundedFix = true;\n`,
      );
      const result = await assessTechnicalDebt({
        cwd: directory,
        before,
        budget: {
          addedDependencies: 0,
          complexityPoints: 0,
          duplicatedLines: 0,
          maximumFileLines: 2,
        },
      });
      expect(result.metrics.maximumFileLines).toBe(2);
      expect(result.violations).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
