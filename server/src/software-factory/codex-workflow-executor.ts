import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "bun";
import { artifactChecksum } from "./workflow-runtime";
import type { WorkflowStageExecutor } from "./workflow-worker";

async function command(args: string[], cwd: string, signal?: AbortSignal) {
  const child = spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const abort = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", abort, { once: true });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  signal?.removeEventListener("abort", abort);
  if (signal?.aborted)
    throw new Error(String(signal.reason ?? "Codex stage was interrupted."));
  if (exitCode !== 0)
    throw new Error(
      `${args[0]} failed (${exitCode}): ${(stderr || stdout).slice(-4_000)}`,
    );
  return { stdout, exitCode };
}

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    checks: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "checks"],
  additionalProperties: false,
};

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    accepted: { type: "boolean" },
    summary: { type: "string" },
    checks: { type: "array", items: { type: "string" } },
  },
  required: ["accepted", "summary", "checks"],
  additionalProperties: false,
};

/** A real subscription-backed executor. Every run keeps its Git worktree across process restarts. */
export function createCodexWorkflowExecutor(
  repository: string,
): WorkflowStageExecutor {
  const root = resolve(repository);

  async function workspace(runId: string) {
    const directory = join(root, ".openbot", "workflows", runId);
    await mkdir(join(root, ".openbot", "workflows"), { recursive: true });
    try {
      await readFile(join(directory, ".git"));
    } catch {
      await command(
        ["git", "worktree", "add", "--detach", directory, "HEAD"],
        root,
      );
    }
    return directory;
  }

  async function codexJson(
    cwd: string,
    sessionId: string,
    schema: Record<string, unknown>,
    prompt: string,
    sandbox: "read-only" | "workspace-write",
    signal: AbortSignal,
  ) {
    const evidence = join(cwd, ".openbot-evidence");
    await mkdir(evidence, { recursive: true });
    const schemaPath = join(evidence, `${sessionId}.schema.json`);
    const outputPath = join(evidence, `${sessionId}.json`);
    await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600 });
    await command(
      [
        "codex",
        "exec",
        "--ephemeral",
        "--approve-for-me",
        "--sandbox",
        sandbox,
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
        prompt,
      ],
      cwd,
      signal,
    );
    return JSON.parse(await readFile(outputPath, "utf8")) as Record<
      string,
      unknown
    >;
  }

  return {
    async execute({ runId, stage, snapshot, sessionId, signal }) {
      const cwd = await workspace(runId);
      const prior = snapshot.artifacts.map((artifact) => ({
        stageId: artifact.stageId,
        uri: artifact.uri,
        checksum: artifact.checksum,
        revision: artifact.revision,
      }));
      const result = await codexJson(
        cwd,
        sessionId,
        RESULT_SCHEMA,
        [
          "Execute one bounded managed-agent stage in this isolated Git worktree.",
          `Objective: ${stage.objective}`,
          `Operator steering: ${JSON.stringify(snapshot.run.steering)}`,
          `Prior provenance-bound artifacts: ${JSON.stringify(prior)}`,
          "Inspect first, implement the requested change, run focused deterministic checks, and do not commit, push, open a PR, or weaken tests.",
          "Return a concise JSON summary and the exact checks run. Human approval is required later.",
        ].join("\n"),
        "workspace-write",
        signal,
      );
      const [revision, diff] = await Promise.all([
        command(["git", "rev-parse", "HEAD"], cwd),
        command(["git", "diff", "--binary", "--no-ext-diff"], cwd),
      ]);
      const content = JSON.stringify({ result, diff: diff.stdout });
      return {
        sessionId,
        summary: String(result.summary ?? "Codex completed the stage."),
        artifacts: [
          {
            kind: "codex-stage-result",
            uri: `workflow://${runId}/${stage.stageId}/${sessionId}.json`,
            content,
            checksum: artifactChecksum(content),
            revision: revision.stdout.trim(),
            producerSessionId: sessionId,
            command:
              "codex exec --ephemeral --approve-for-me --sandbox workspace-write",
            exitCode: 0,
            metadata: {
              checks: result.checks ?? [],
              diffBytes: diff.stdout.length,
            },
          },
        ],
      };
    },

    async review({ runId, stage, candidate, sessionId, signal }) {
      const cwd = await workspace(runId);
      const result = await codexJson(
        cwd,
        sessionId,
        REVIEW_SCHEMA,
        [
          "Independently review this managed-agent stage from fresh context.",
          `Objective: ${stage.objective}`,
          `Candidate summary: ${candidate.summary}`,
          `Artifacts: ${JSON.stringify(candidate.artifacts.map(({ uri, checksum, revision }) => ({ uri, checksum, revision })))}`,
          "Inspect the actual uncommitted diff and run focused checks yourself. Reject on missing evidence, weakened tests, unverifiable behavior, or unmet objective.",
          "Return JSON with accepted, summary, and exact checks you independently ran.",
        ].join("\n"),
        "read-only",
        signal,
      );
      return {
        accepted: result.accepted === true,
        summary: String(result.summary ?? "Reviewer returned no summary."),
        checks: Array.isArray(result.checks)
          ? result.checks.filter(
              (value): value is string => typeof value === "string",
            )
          : [],
      };
    },
  };
}
