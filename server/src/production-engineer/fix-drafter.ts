import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import {
  assessTechnicalDebt,
  debtBudgetFromEnvironment,
} from "../../../agent-codex/src/debt";
import { type FixDrafter, TechnicalDebtGateError } from "./store";

async function command(args: string[], cwd: string) {
  const child = spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0) {
    throw new Error(
      `${args[0]} failed (${status}): ${(stderr || stdout).slice(-2_000)}`,
    );
  }
  return stdout.trim();
}

/**
 * High-risk and disabled by default. Once an administrator approves a production issue, this uses
 * an isolated worktree, asks Codex to implement and test one bounded fix, and opens a PR. It never
 * checks out or pushes main and never merges the result.
 */
export function createCodexFixDrafter(repository: string): FixDrafter {
  return async (input) => {
    const baseBranch = await command(
      ["git", "branch", "--show-current"],
      repository,
    );
    if (!baseBranch) throw new Error("Autonomous fixes require a named base branch.");
    const branch = `openbot/production-${input.issueId.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
    const worktree = await mkdtemp(join(tmpdir(), "openbot-production-fix-"));
    await command(
      ["git", "worktree", "add", "-b", branch, worktree, "HEAD"],
      repository,
    );
    let keepBranch = false;
    try {
      const prompt = [
        "Fix this production issue in the current worktree.",
        `Title: ${input.title}`,
        `Root cause: ${input.rootCause}`,
        `Evidence: ${JSON.stringify(input.evidence)}`,
        "Keep the change bounded, add regression tests, run focused validation, and do not commit, push, merge, or weaken tests.",
      ].join("\n");
      await command(["codex", "exec", "--approve-for-me", prompt], worktree);
      const debt = await assessTechnicalDebt({
        cwd: worktree,
        before: [],
        budget: debtBudgetFromEnvironment(process.env),
      });
      if (debt.violations.length > 0) throw new TechnicalDebtGateError(debt);
      await command(["bun", "run", "typecheck"], worktree);
      await command(["git", "add", "-A"], worktree);
      await command(
        ["git", "commit", "-m", `fix: ${input.title.slice(0, 68)}`],
        worktree,
      );
      await command(["git", "push", "-u", "origin", branch], worktree);
      const pullRequestUrl = await command(
        [
          "gh",
          "pr",
          "create",
          "--head",
          branch,
          "--base",
          baseBranch,
          "--title",
          `fix: ${input.title}`,
          "--body",
          `Production Engineer issue ${input.issueId}. Human-approved draft; requires normal review and evolution verification before merge.`,
        ],
        worktree,
      );
      keepBranch = true;
      return { branch, pullRequestUrl, debt };
    } finally {
      await command(
        ["git", "worktree", "remove", "--force", worktree],
        repository,
      ).catch(() => undefined);
      if (!keepBranch) {
        await command(["git", "branch", "-D", branch], repository).catch(
          () => undefined,
        );
      }
    }
  };
}
