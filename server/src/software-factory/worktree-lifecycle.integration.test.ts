import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexWorkflowExecutor } from "./codex-workflow-executor";
import { createSoftwareFactoryRoutes } from "./routes";
import { verifyWorkflowEvidence } from "./workflow-runtime";
import { createWorkflowWorker } from "./workflow-worker";

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

function diskKilobytes(directory: string) {
  if (!existsSync(directory)) return 0;
  const result = Bun.spawnSync(["du", "-sk", directory]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return Number(result.stdout.toString().trim().split(/\s+/)[0]);
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
      await mkdir(join(workspaceRoot, "worktrees"), { recursive: true });
      const before = {
        at: new Date().toISOString(),
        diskKilobytes: diskKilobytes(join(workspaceRoot, "worktrees")),
      };
      const candidate = await execute(runId);
      const during = await executor.worktreeStats?.();
      expect(during?.active).toBe(1);
      expect(during?.diskBytes).toBeGreaterThan(0);
      const duringDisk = {
        at: new Date().toISOString(),
        diskKilobytes: diskKilobytes(join(workspaceRoot, "worktrees")),
      };
      expect(duringDisk.diskKilobytes).toBeGreaterThan(before.diskKilobytes);
      const evidencePath = String(
        candidate.artifacts.find(({ kind }) => kind === "codex-stage-result")
          ?.metadata?.reviewMaterialPath,
      );
      let claimed = false;
      const worker = createWorkflowWorker({
        workerId: "terminal-cleanup-proof",
        executor: {
          harness: "codex",
          run: executor.run,
          review: executor.review,
          interrupt: executor.interrupt,
          cleanup: executor.cleanup,
          worktreeStats: executor.worktreeStats,
        },
        runtime: {
          protectedWorktreeRunIds: async () => [runId],
          claim: async () => {
            if (claimed) return null;
            claimed = true;
            return { id: runId, status: "running" };
          },
          renewLease: async () => true,
          readyStages: async () => [],
          snapshot: async () => ({
            run: { id: runId, status: terminalState },
            stages: [],
            artifacts: [],
            events: [],
          }),
        } as never,
      });
      expect(await worker.runOnce()).toMatchObject({
        claimed: true,
        runId,
      });
      await expect(
        access(join(workspaceRoot, "worktrees", runId)),
      ).rejects.toThrow();
      expect(git("worktree", "list", "--porcelain")).not.toContain(runId);
      await access(evidencePath);
      expect(await executor.worktreeStats?.()).toEqual({
        active: 0,
        diskBytes: 0,
      });
      const after = {
        at: new Date().toISOString(),
        diskKilobytes: diskKilobytes(join(workspaceRoot, "worktrees")),
      };
      console.info(
        JSON.stringify({
          proof: "worktree-terminal-cleanup",
          runId,
          terminalState,
          before,
          during: { ...duringDisk, ...during },
          after: { ...after, ...(await executor.worktreeStats?.()) },
          evidencePath,
        }),
      );
      expect(after.diskKilobytes).toBe(before.diskKilobytes);
      expect(Date.parse(duringDisk.at)).toBeGreaterThanOrEqual(
        Date.parse(before.at),
      );
      expect(Date.parse(after.at)).toBeGreaterThanOrEqual(
        Date.parse(duringDisk.at),
      );
      if (terminalState === "succeeded") {
        const durableArtifacts = candidate.artifacts.map((artifact, index) => ({
          id: `${runId}-artifact-${index}`,
          runId,
          ...artifact,
          stageId: "verify",
          exitCode: artifact.exitCode ?? null,
        }));
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
          artifacts: durableArtifacts,
        });
        expect(proof.verified).toBe(true);
        const routes = createSoftwareFactoryRoutes(
          {} as never,
          {} as never,
          "tenant-proof",
          async (context, next) => {
            context.set("actor", {
              id: "admin-proof",
              email: "admin@example.test",
              role: "admin",
            });
            await next();
          },
          undefined,
          undefined,
          {
            snapshot: async () => ({ artifacts: durableArtifacts }),
          } as never,
        );
        const artifactResponse = await routes.request(
          `/workflows/${runId}/artifacts/${durableArtifacts[0]!.id}`,
        );
        expect(artifactResponse.status).toBe(200);
        expect(await artifactResponse.json()).toMatchObject({
          id: durableArtifacts[0]!.id,
          runId,
          content: durableArtifacts[0]!.content,
          checksum: durableArtifacts[0]!.checksum,
        });
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

  test("migrates evidence and empties every registered legacy-location worktree", async () => {
    const { root, workspaceRoot, executor, git } = await fixture();
    const legacyRoot = join(root, "server", ".openbot", "workflows");
    const runIds = [
      `legacy-${crypto.randomUUID()}`,
      `legacy-${crypto.randomUUID()}`,
    ];
    for (const runId of runIds) {
      const legacy = join(legacyRoot, runId);
      git("worktree", "add", "--detach", legacy, "HEAD");
      await writeFile(join(legacy, ".openbot-evidence"), runId);
    }

    await executor.sweep?.(new Set());

    expect(await readdir(legacyRoot)).toEqual([]);
    const listed = git("worktree", "list", "--porcelain");
    for (const runId of runIds) {
      expect(listed).not.toContain(runId);
      expect(
        await Bun.file(join(workspaceRoot, "evidence", runId, "legacy")).text(),
      ).toBe(runId);
    }
  });
});
