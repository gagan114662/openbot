import { afterAll, describe, expect, test } from "bun:test";
import {
  access,
  chmod,
  mkdtemp,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexWorkflowExecutor } from "./codex-workflow-executor";
import { verifyWorkflowEvidence } from "./workflow-runtime";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(retentionMs = 1_000) {
  const root = await mkdtemp(join(tmpdir(), "openbot-worktree-repo-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "openbot-worktrees-"));
  roots.push(root, workspaceRoot);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString();
  };
  git("init", "-q");
  git("config", "user.email", "worktree@openbot.test");
  git("config", "user.name", "OpenBot worktree proof");
  await writeFile(join(root, "README.md"), "worktree proof\n");
  git("add", "README.md");
  git("commit", "-qm", "fixture");
  const binary = join(root, "fake-codex");
  await writeFile(
    binary,
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
const output = args[args.indexOf("--output-last-message") + 1];
await Bun.write(output, JSON.stringify({ summary: "bounded worker", checks: [] }));
`,
  );
  await chmod(binary, 0o700);
  const executor = createCodexWorkflowExecutor(root, {
    binary,
    workspaceRoot,
    retentionMs,
  });
  const stage = {
    stageId: "verify",
    objective: "produce durable evidence",
    requiredContext: { keys: [] },
    dependsOn: { ids: [] },
    checks: { items: [] },
    selectedModel: "gpt-proof",
    selectedHarness: "codex",
    lastError: null,
  };
  const execute = (runId: string) =>
    executor.run({
      runId,
      stage,
      snapshot: { run: { steering: { events: [] } }, artifacts: [] },
      sessionId: `${runId}-worker`,
      signal: new AbortController().signal,
    } as never);
  return { root, workspaceRoot, executor, execute, git };
}

describe("real Git worktree lifecycle", () => {
  test.each(["succeeded", "failed", "aborted"] as const)(
    "removes and prunes a %s run while retaining external evidence",
    async (terminalState) => {
      const { workspaceRoot, executor, execute, git } = await fixture();
      const runId = `${terminalState}-${crypto.randomUUID()}`;
      expect(await executor.worktreeStats?.()).toEqual({
        active: 0,
        diskBytes: 0,
      });
      const candidate = await execute(runId);
      const during = await executor.worktreeStats?.();
      expect(during?.active).toBe(1);
      expect(during?.diskBytes).toBeGreaterThan(0);
      const evidencePath = String(
        candidate.artifacts[0]?.metadata?.reviewMaterialPath,
      );
      await executor.cleanup?.(runId);
      await expect(
        access(join(workspaceRoot, "worktrees", runId)),
      ).rejects.toThrow();
      expect(git("worktree", "list", "--porcelain")).not.toContain(runId);
      await access(evidencePath);
      expect(await executor.worktreeStats?.()).toEqual({
        active: 0,
        diskBytes: 0,
      });
      if (terminalState === "succeeded") {
        const proof = verifyWorkflowEvidence({
          run: { status: "succeeded", approvedBy: "admin" },
          stages: [
            {
              stageId: "verify",
              status: "succeeded",
              sessionId: `${runId}-worker`,
              reviewerSessionId: `${runId}-reviewer`,
              verification: { accepted: true },
            },
          ],
          artifacts: candidate.artifacts.map((artifact) => ({
            ...artifact,
            stageId: "verify",
            exitCode: artifact.exitCode ?? null,
          })),
        });
        expect(proof.verified).toBe(true);
      }
    },
  );

  test("sweeps two old orphaned real worktrees and preserves a younger one", async () => {
    const { workspaceRoot, executor, execute, git } = await fixture(1_000);
    const oldRuns = [
      `old-${crypto.randomUUID()}`,
      `old-${crypto.randomUUID()}`,
    ];
    const youngRun = `young-${crypto.randomUUID()}`;
    for (const runId of [...oldRuns, youngRun]) await execute(runId);
    const old = new Date(Date.now() - 5_000);
    for (const runId of oldRuns)
      await utimes(join(workspaceRoot, "worktrees", runId), old, old);

    await executor.sweep?.(new Set());

    const listed = git("worktree", "list", "--porcelain");
    for (const runId of oldRuns) {
      await expect(
        access(join(workspaceRoot, "worktrees", runId)),
      ).rejects.toThrow();
      expect(listed).not.toContain(runId);
    }
    await access(join(workspaceRoot, "worktrees", youngRun));
    expect(listed).toContain(youngRun);
    await executor.cleanup?.(youngRun);
  });

  test("migrates evidence before removing a registered legacy-location worktree", async () => {
    const { root, workspaceRoot, executor, git } = await fixture();
    const runId = `legacy-${crypto.randomUUID()}`;
    const legacy = join(root, "server", ".openbot", "workflows", runId);
    git("worktree", "add", "--detach", legacy, "HEAD");
    await writeFile(join(legacy, ".openbot-evidence"), "legacy evidence");

    await executor.sweep?.(new Set());

    await expect(access(legacy)).rejects.toThrow();
    expect(git("worktree", "list", "--porcelain")).not.toContain(runId);
    expect(
      await Bun.file(join(workspaceRoot, "evidence", runId, "legacy")).text(),
    ).toBe("legacy evidence");
  });
});
