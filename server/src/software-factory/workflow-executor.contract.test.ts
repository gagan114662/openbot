import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createClaudeWorkflowExecutor,
  createCodexWorkflowExecutor,
} from "./codex-workflow-executor";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(harness: "codex" | "claude") {
  const root = await mkdtemp(join(tmpdir(), `openbot-${harness}-contract-`));
  roots.push(root);
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(args, {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  run("git", "init", "-q");
  run("git", "config", "user.email", "contract@openbot.test");
  run("git", "config", "user.name", "OpenBot contract");
  await writeFile(join(root, "README.md"), "contract\n");
  run("git", "add", "README.md");
  run("git", "commit", "-qm", "fixture");
  const binary = join(root, `fake-${harness}`);
  await writeFile(
    binary,
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
const prompt = args.includes("-p") ? args[args.indexOf("-p") + 1] : args.at(-1) ?? "";
const review = prompt.includes("Independently review");
const payload = review
  ? { accepted: true, summary: "fresh fake review", checks: ["contract"] }
  : { summary: "fake worker result", checks: ["model reported"] };
if (${JSON.stringify(harness)} === "codex") {
  const output = args[args.indexOf("--output-last-message") + 1];
  await Bun.write(output, JSON.stringify(payload));
} else {
  process.stdout.write(JSON.stringify({ result: JSON.stringify(payload) }));
}
`,
    { mode: 0o700 },
  );
  await chmod(binary, 0o700);
  return { root, binary };
}

describe.each(["codex", "claude"] as const)(
  "%s workflow harness",
  (harness) => {
    test("honours the persisted model and satisfies the shared executor contract", async () => {
      const { root, binary } = await fixture(harness);
      const executor =
        harness === "codex"
          ? createCodexWorkflowExecutor(root, { binary })
          : createClaudeWorkflowExecutor(root, { binary });
      const runId = crypto.randomUUID();
      const stage = {
        stageId: "verify",
        objective: "prove the shared harness contract",
        requiredContext: { keys: [] },
        dependsOn: { ids: [] },
        checks: {
          items: [
            {
              id: "runtime-command",
              command: ["git", "diff", "--check"],
              timeoutMs: 10_000,
              required: true,
            },
          ],
        },
        selectedModel: harness === "codex" ? "gpt-contract" : "claude-contract",
        selectedHarness: harness,
        lastError: null,
      };
      const snapshot = {
        run: { steering: { events: [] } },
        artifacts: [],
      };
      const candidate = await executor.run({
        runId,
        stage,
        snapshot,
        sessionId: "worker-session",
        signal: new AbortController().signal,
      } as never);
      expect(candidate.sessionId).toBe("worker-session");
      expect(candidate.artifacts).toHaveLength(2);
      expect(candidate.artifacts[0]?.metadata).toMatchObject({
        harness,
        model: stage.selectedModel,
      });
      expect(candidate.artifacts[1]).toMatchObject({
        kind: "runtime-check",
        exitCode: 0,
      });
      expect(
        String(candidate.artifacts[1]?.metadata?.reviewMaterialPath),
      ).not.toStartWith(`${root}/`);
      const review = await executor.review({
        runId,
        stage,
        snapshot,
        candidate,
        sessionId: "fresh-reviewer-session",
        signal: new AbortController().signal,
      } as never);
      expect(review).toMatchObject({ accepted: true, checks: ["contract"] });
      await executor.interrupt();
    });
  },
);
