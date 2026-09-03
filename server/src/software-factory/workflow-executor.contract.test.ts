import { afterAll, describe, expect, test } from "bun:test";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createClaudeWorkflowExecutor,
  createCodexWorkflowExecutor,
} from "./codex-workflow-executor";
import { subscribeWorkflowEvents } from "./workflow-stream";
import { StageExecutionFailure } from "./workflow-worker";

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
  const workerPrompt = join(root, `worker-${harness}.txt`);
  await writeFile(
    binary,
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
const prompt = args.includes("-p") ? args[args.indexOf("-p") + 1] : args.at(-1) ?? "";
const review = prompt.includes("Independently review");
if (review) await Bun.write(${JSON.stringify(reviewPrompt)}, prompt);
else await Bun.write(${JSON.stringify(workerPrompt)}, prompt);
const payload = review
  ? {
      accepted:
        prompt.includes("Runtime-scoped candidate diff") &&
        prompt.includes('"kind":"runtime-check"') &&
        !prompt.includes("fake worker result") &&
        !prompt.includes("model reported") &&
        !prompt.includes('"modifiedByCandidate":true'),
      summary: "fresh fake review",
      checks: ["contract"],
    }
  : { summary: "fake worker result", checks: ["model reported"] };
if (${JSON.stringify(harness)} === "codex") {
  if (!args.includes("--sandbox")) process.exit(43);
  if (!args.includes("sandbox_workspace_write.exclude_tmpdir_env_var=true")) process.exit(44);
  if (!args.includes("sandbox_workspace_write.exclude_slash_tmp=true")) process.exit(45);
  const output = args[args.indexOf("--output-last-message") + 1];
  await Bun.write(output, JSON.stringify(payload));
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 200, output_tokens: 300 } }) + "\\n");
} else {
  if (!args.includes("--json-schema")) process.exit(42);
  if (!args.includes("--restricted")) process.exit(44);
  if (!args.includes("--permission-prompts") || !args.includes("none")) process.exit(45);
  if (!args.includes("--disallowedTools") || !args.includes("Bash,WebFetch,WebSearch")) process.exit(43);
  process.stdout.write(JSON.stringify({ structured_output: payload, result: "fallback must not run", usage: { input_tokens: 1000, cache_read_input_tokens: 100, output_tokens: 250 }, total_cost_usd: 0.0042 }));
}
`,
    { mode: 0o700 },
  );
  await chmod(binary, 0o700);
  return { root, binary, workspaceRoot, reviewPrompt, workerPrompt };
}

describe.each(["codex", "claude"] as const)(
  "%s workflow harness",
  (harness) => {
    test("honours the persisted model and satisfies the shared executor contract", async () => {
      const { root, binary, workspaceRoot, reviewPrompt, workerPrompt } =
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
              command: ["bun", "-e", "console.log('check-output')"],
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
      const streamed: string[] = [];
      let candidateResolved = false;
      const stopStream = subscribeWorkflowEvents(runId, (event) => {
        if (event.type !== "check-output") return;
        expect(candidateResolved).toBe(false);
        streamed.push(String(event.payload.chunk));
      });
      const candidate = await executor.run({
        runId,
        stage,
        snapshot,
        sessionId: "worker-session",
        signal: new AbortController().signal,
      } as never);
      candidateResolved = true;
      stopStream();
      expect(streamed.join("")).toContain("check-output");
      expect(candidate.sessionId).toBe("worker-session");
      expect(candidate.artifacts).toHaveLength(4);
      expect(candidate.artifacts[0]?.kind).toBe("model-prompt");
      expect(candidate.artifacts[0]?.content).toContain("Operator steering:");
      expect(candidate.artifacts[1]?.metadata).toMatchObject({
        harness,
        model: stage.selectedModel,
        usage: expect.objectContaining({ totalTokens: expect.any(Number) }),
      });
      expect(candidate.artifacts[2]).toMatchObject({
        kind: "runtime-check",
        exitCode: 0,
        metadata: { checkId: "gate-integrity" },
      });
      expect(candidate.artifacts[3]).toMatchObject({
        kind: "runtime-check",
        exitCode: 0,
        metadata: {
          resolvedExecutablePaths: {
            command: expect.stringMatching(/^\//),
            git: expect.stringMatching(/^\//),
          },
        },
      });
      const executionPrompt = await Bun.file(workerPrompt).text();
      expect(executionPrompt).toContain("prove the shared harness contract");
      expect(executionPrompt).not.toContain("with these exact UTF-8 bytes");
      expect(executionPrompt).not.toContain("OPENBOT_PRIVATE_EXPECTED_BYTES");
      expect(JSON.parse(candidate.artifacts[3]!.content)).toMatchObject({
        kind: "runtime-check",
        exitCode: 0,
      });
      expect(
        String(candidate.artifacts[3]?.metadata?.reviewMaterialPath),
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
        candidate.artifacts[2]?.metadata?.reviewMaterialPath,
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

test("gate-integrity rejects a candidate that weakens repository configuration", async () => {
  const { root, binary, workspaceRoot } = await fixture("codex");
  await writeFile(
    binary,
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
await Bun.write("biome.json", JSON.stringify({ linter: { enabled: false } }));
const output = args[args.indexOf("--output-last-message") + 1];
await Bun.write(output, JSON.stringify({ summary: "disabled the gate", checks: [] }));
process.stdout.write(JSON.stringify({ usage: { input_tokens: 100, output_tokens: 20 } }) + "\\n");
`,
    { mode: 0o700 },
  );
  await chmod(binary, 0o700);
  const executor = createCodexWorkflowExecutor(root, { binary, workspaceRoot });
  const run = executor.run({
    runId: crypto.randomUUID(),
    stage: {
      stageId: "verify",
      objective: "introduce a lint violation without weakening the gate",
      requiredContext: { keys: [] },
      dependsOn: { ids: [] },
      checks: { items: [] },
      selectedModel: "gpt-contract",
      selectedHarness: "codex",
      lastError: null,
    },
    snapshot: { run: { steering: { events: [] } }, artifacts: [] },
    sessionId: "hostile-worker",
    signal: new AbortController().signal,
  } as never);
  await expect(run).rejects.toBeInstanceOf(StageExecutionFailure);
  await expect(run).rejects.toMatchObject({
    artifacts: [
      expect.objectContaining({
        exitCode: 1,
        metadata: expect.objectContaining({ protectedPaths: ["biome.json"] }),
      }),
    ],
  });
});

test("a candidate-modified named test is disclosed to and rejected by the fresh reviewer", async () => {
  const { root, binary, workspaceRoot, reviewPrompt } = await fixture("codex");
  await writeFile(
    binary,
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
const prompt = args.at(-1) ?? "";
const review = prompt.includes("Independently review");
const payload = review
  ? { accepted: !prompt.includes('"modifiedByCandidate":true'), summary: "fresh review", checks: ["test provenance"] }
  : { summary: "rewrote the named test", checks: [] };
if (!review) await Bun.write("proof.test.ts", "import {test,expect} from 'bun:test';test('weakened',()=>expect(true).toBe(true));\\n");
else await Bun.write(${JSON.stringify(reviewPrompt)}, prompt);
const output = args[args.indexOf("--output-last-message") + 1];
await Bun.write(output, JSON.stringify(payload));
process.stdout.write(JSON.stringify({ usage: { input_tokens: 100, output_tokens: 20 } }) + "\\n");
`,
    { mode: 0o700 },
  );
  await chmod(binary, 0o700);
  const executor = createCodexWorkflowExecutor(root, { binary, workspaceRoot });
  const runId = crypto.randomUUID();
  const stage = {
    stageId: "verify",
    objective: "repair behavior without weakening its test",
    requiredContext: { keys: [] },
    dependsOn: { ids: [] },
    checks: {
      items: [
        {
          id: "named-test",
          command: ["bun", "test", "proof.test.ts"],
          timeoutMs: 10_000,
          required: true,
        },
      ],
    },
    selectedModel: "gpt-contract",
    selectedHarness: "codex",
    lastError: null,
  };
  const snapshot = { run: { steering: { events: [] } }, artifacts: [] };
  const candidate = await executor.run({
    runId,
    stage,
    snapshot,
    sessionId: "test-rewriter",
    signal: new AbortController().signal,
  } as never);
  expect(candidate.artifacts).toContainEqual(
    expect.objectContaining({
      metadata: expect.objectContaining({ modifiedByCandidate: true }),
    }),
  );
  const verdict = await executor.review({
    runId,
    stage,
    snapshot,
    candidate,
    sessionId: "fresh-reviewer",
    signal: new AbortController().signal,
  } as never);
  expect(verdict.accepted).toBe(false);
  expect(await Bun.file(reviewPrompt).text()).toContain(
    '"modifiedByCandidate":true',
  );
});

test("a spawned Bun check supplies its own failing and repaired exit evidence", async () => {
  const { root, binary, workspaceRoot } = await fixture("codex");
  const counter = join(root, "attempt-count");
  await writeFile(
    binary,
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
const prompt = args.at(-1) ?? "";
const review = prompt.includes("Independently review");
let attempt = 0;
try { attempt = Number(await Bun.file(${JSON.stringify(counter)}).text()); } catch {}
if (!review) {
  attempt += 1;
  await Bun.write(${JSON.stringify(counter)}, String(attempt));
  const expected = attempt === 1 ? 2 : 1;
  await Bun.write("focused.test.ts", "import {test,expect} from 'bun:test';test('process-owned verdict',()=>expect(1).toBe(" + expected + "));\\n");
}
const payload = review
  ? { accepted: true, summary: "fresh review", checks: ["spawned process evidence"] }
  : { summary: "candidate attempt " + attempt, checks: [] };
const output = args[args.indexOf("--output-last-message") + 1];
await Bun.write(output, JSON.stringify(payload));
process.stdout.write(JSON.stringify({ usage: { input_tokens: 100, output_tokens: 20 } }) + "\\n");
`,
    { mode: 0o700 },
  );
  await chmod(binary, 0o700);
  const executor = createCodexWorkflowExecutor(root, { binary, workspaceRoot });
  const runId = crypto.randomUUID();
  const stage = {
    stageId: "verify",
    objective: "repair the failing focused test",
    requiredContext: { keys: [] },
    dependsOn: { ids: [] },
    checks: {
      items: [
        {
          id: "focused",
          command: ["bun", "test", "focused.test.ts"],
          timeoutMs: 10_000,
          required: true,
        },
      ],
    },
    selectedModel: "gpt-contract",
    selectedHarness: "codex",
    lastError: null,
  };
  const input = {
    runId,
    stage,
    snapshot: { run: { steering: { events: [] } }, artifacts: [] },
    signal: new AbortController().signal,
  };
  let failure: StageExecutionFailure | undefined;
  try {
    await executor.run({ ...input, sessionId: "failing-attempt" } as never);
  } catch (error) {
    if (error instanceof StageExecutionFailure) failure = error;
    else throw error;
  }
  expect(failure).toBeDefined();
  const failedCheck = failure?.artifacts.find(
    (artifact) => artifact.metadata?.checkId === "focused",
  );
  expect(failedCheck?.exitCode).not.toBe(0);
  expect(failedCheck?.content).toContain("process-owned verdict");
  expect(failedCheck?.content).toContain("Expected: 2");

  const repaired = await executor.run({
    ...input,
    sessionId: "repaired-attempt",
  } as never);
  const repairedCheck = repaired.artifacts.find(
    (artifact) => artifact.metadata?.checkId === "focused",
  );
  expect(repairedCheck?.exitCode).toBe(0);
  expect(repairedCheck?.content).toContain("1 pass");
});

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
