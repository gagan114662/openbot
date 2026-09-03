import { afterAll, describe, expect, test } from "bun:test";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), `openbot-${harness}-workspaces-`),
  );
  roots.push(root, workspaceRoot);
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
  const reviewPrompt = join(root, `review-${harness}.txt`);
  await writeFile(
    binary,
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
const prompt = args.includes("-p") ? args[args.indexOf("-p") + 1] : args.at(-1) ?? "";
const review = prompt.includes("Independently review");
if (review) await Bun.write(${JSON.stringify(reviewPrompt)}, prompt);
const payload = review
  ? {
      accepted:
        prompt.includes("Runtime-scoped candidate diff") &&
        prompt.includes('"kind":"runtime-check"') &&
        !prompt.includes("fake worker result") &&
        !prompt.includes("model reported"),
      summary: "fresh fake review",
      checks: ["contract"],
    }
  : { summary: "fake worker result", checks: ["model reported"] };
if (${JSON.stringify(harness)} === "codex") {
  if (!args.includes("--sandbox")) process.exit(43);
  const output = args[args.indexOf("--output-last-message") + 1];
  await Bun.write(output, JSON.stringify(payload));
} else {
  if (!args.includes("--json-schema")) process.exit(42);
  if (!args.includes("--disallowedTools") || !args.includes("Bash,WebFetch,WebSearch")) process.exit(43);
  process.stdout.write(JSON.stringify({ structured_output: payload, result: "fallback must not run" }));
}
`,
    { mode: 0o700 },
  );
  await chmod(binary, 0o700);
  return { root, binary, workspaceRoot, reviewPrompt };
}

describe.each(["codex", "claude"] as const)(
  "%s workflow harness",
  (harness) => {
    test("honours the persisted model and satisfies the shared executor contract", async () => {
      const { root, binary, workspaceRoot, reviewPrompt } =
        await fixture(harness);
      const executor =
        harness === "codex"
          ? createCodexWorkflowExecutor(root, { binary, workspaceRoot })
          : createClaudeWorkflowExecutor(root, { binary, workspaceRoot });
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
      expect(JSON.parse(candidate.artifacts[1]!.content)).toMatchObject({
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
      const prompt = await Bun.file(reviewPrompt).text();
      expect(prompt).not.toContain("Candidate summary");
      expect(prompt).not.toContain("fake worker result");
      expect(prompt).not.toContain("model reported");
      expect(prompt).toContain('"kind":"runtime-check"');
      const evidencePath = String(
        candidate.artifacts[1]?.metadata?.reviewMaterialPath,
      );
      await executor.cleanup?.(runId);
      await expect(
        access(join(workspaceRoot, "worktrees", runId)),
      ).rejects.toThrow();
      await access(evidencePath);
      await executor.interrupt();
    });
  },
);

test("Claude refuses unvalidated fallback text when structured_output is absent", async () => {
  const { root, binary, workspaceRoot } = await fixture("claude");
  await writeFile(
    binary,
    `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ result: ${JSON.stringify(
      JSON.stringify({ summary: "unvalidated", checks: [] }),
    )} }));
`,
    { mode: 0o700 },
  );
  await chmod(binary, 0o700);
  const executor = createClaudeWorkflowExecutor(root, {
    binary,
    workspaceRoot,
  });
  const runId = crypto.randomUUID();
  await expect(
    executor.run({
      runId,
      stage: {
        stageId: "verify",
        objective: "refuse fallback text",
        requiredContext: { keys: [] },
        dependsOn: { ids: [] },
        checks: { items: [] },
        selectedModel: "claude-contract",
        selectedHarness: "claude",
        lastError: null,
      },
      snapshot: { run: { steering: { events: [] } }, artifacts: [] },
      sessionId: "fallback-refusal-session",
      signal: new AbortController().signal,
    } as never),
  ).rejects.toThrow("CLI-validated structured_output");
  await executor.cleanup?.(runId);
});
