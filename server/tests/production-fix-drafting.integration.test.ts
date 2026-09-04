import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { auditEvents, productionIssues } from "../src/db/schema";
import { createCodexFixDrafter } from "../src/production-engineer/fix-drafter";
import {
  createProductionEngineerStore,
  FixAlreadyClaimedError,
} from "../src/production-engineer/store";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const issueIds: string[] = [];
const temporaryDirectories: string[] = [];
const originalPath = process.env.PATH;

async function run(args: string[], cwd: string) {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0)
    throw new Error(`${args.join(" ")} failed (${status}): ${stderr}`);
  return stdout.trim();
}

/**
 * A real repository for the real drafter: git worktrees, branches, commits and
 * pushes are genuine. Only the two external network programs are shimmed on
 * PATH — `codex` writes a marker file and blocks until released so the test can
 * observe mid-flight state, and `gh` prints a pull-request URL instead of
 * calling GitHub. The origin fetch URL looks like GitHub (the drafter validates
 * it) while pushes are redirected to a local bare repository.
 */
async function fixtureRepository() {
  const repository = await mkdtemp(join(tmpdir(), "openbot-fix-repo-"));
  const bare = await mkdtemp(join(tmpdir(), "openbot-fix-origin-"));
  const shims = await mkdtemp(join(tmpdir(), "openbot-fix-shims-"));
  const codexLog = join(shims, "codex-invocations.log");
  const release = join(shims, "release-codex");
  temporaryDirectories.push(repository, bare, shims);

  await run(["git", "init", "--bare"], bare);
  await run(["git", "init", "-b", "main"], repository);
  await run(["git", "config", "user.email", "fixture@test"], repository);
  await run(["git", "config", "user.name", "Fixture"], repository);
  await run(["git", "config", "core.hooksPath", "/dev/null"], repository);
  // A dependency-free `bun install` writes no lockfile, and the drafter's
  // `--frozen-lockfile` install inside the worktree then refuses to run. One
  // local file: dependency makes the committed bun.lock real.
  await mkdir(join(repository, "dep"));
  await writeFile(
    join(repository, "dep", "package.json"),
    JSON.stringify({ name: "fixture-dep", version: "0.0.0" }),
  );
  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "0.0.0",
      scripts: { typecheck: "true" },
      dependencies: { "fixture-dep": "file:./dep" },
    }),
  );
  await run(["bun", "install"], repository);
  await run(["git", "add", "-A"], repository);
  await run(["git", "commit", "-m", "fixture"], repository);
  await run(
    [
      "git",
      "remote",
      "add",
      "origin",
      "https://github.com/example/fixture.git",
    ],
    repository,
  );
  await run(["git", "remote", "set-url", "--push", "origin", bare], repository);

  await writeFile(
    join(shims, "codex"),
    [
      "#!/bin/sh",
      `echo invoked >> "${codexLog}"`,
      'printf "drafted fix" > codex-fix.txt',
      `while [ ! -f "${release}" ]; do sleep 0.05; done`,
    ].join("\n"),
    { mode: 0o755 },
  );
  await writeFile(
    join(shims, "gh"),
    ["#!/bin/sh", 'echo "https://github.com/example/fixture/pull/35"'].join(
      "\n",
    ),
    { mode: 0o755 },
  );
  process.env.PATH = `${shims}:${originalPath}`;
  return { repository, codexLog, release };
}

async function productionWorktrees(repository: string) {
  const listed = await run(
    ["git", "worktree", "list", "--porcelain"],
    repository,
  );
  return listed
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .filter((line) => !line.endsWith(repository));
}

afterAll(async () => {
  process.env.PATH = originalPath;
  // audit_events is append-only (a trigger refuses deletes); only issue rows
  // are removed.
  if (issueIds.length > 0)
    await database
      .delete(productionIssues)
      .where(inArray(productionIssues.id, issueIds));
  for (const directory of temporaryDirectories)
    await rm(directory, { recursive: true, force: true });
});

test("four concurrent drafts spawn one drafter process, one git worktree, and one branch", async () => {
  const { repository, codexLog, release } = await fixtureRepository();
  const [issue] = await database
    .insert(productionIssues)
    .values({
      fingerprint: `real-drafter-${crypto.randomUUID()}`,
      title: "Only one drafter may run",
      severity: "high",
      rootCause: "double-clicked fix button",
    })
    .returning();
  issueIds.push(issue!.id);
  const store = createProductionEngineerStore(
    database,
    createCodexFixDrafter(repository),
  );

  const settled: PromiseSettledResult<unknown>[] = [];
  const requests = Array.from({ length: 4 }, (_, caller) =>
    store
      .draftFix(`admin-${caller}`, issue!.id)
      .then((value) => settled.push({ status: "fulfilled", value }))
      .catch((reason) => settled.push({ status: "rejected", reason })),
  );

  // The winner is now blocked inside the shimmed `codex`; every loser has been
  // refused at the claim. Mid-flight is the only honest moment to count
  // worktrees: after completion the drafter cleans its worktree up again.
  while (
    !(await readFile(codexLog, "utf8").catch(() => "")).includes("invoked")
  ) {
    if (settled.length === 4)
      throw new Error(
        `No draft reached the drafter: ${settled
          .map((result) =>
            result.status === "rejected" ? String(result.reason) : "fulfilled",
          )
          .join(" | ")}`,
      );
    await Bun.sleep(20);
  }
  // Bounded: with the claim guard intact the three losers settle almost
  // instantly. If a regression lets several drafts through, none of them
  // settles (each blocks in codex) — fall through and let the worktree count
  // fail loudly instead of spinning to the test timeout.
  const settleDeadline = Date.now() + 5_000;
  while (settled.length < 3 && Date.now() < settleDeadline) await Bun.sleep(20);

  expect(await productionWorktrees(repository)).toHaveLength(1);
  const rejections = settled.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  expect(rejections).toHaveLength(3);
  const [row] = await database
    .select()
    .from(productionIssues)
    .where(eq(productionIssues.id, issue!.id));
  for (const rejection of rejections) {
    expect(rejection.reason).toBeInstanceOf(FixAlreadyClaimedError);
    expect((rejection.reason as FixAlreadyClaimedError).existing).toMatchObject(
      { fixId: row!.fixClaimId, fixStatus: "running" },
    );
  }

  await writeFile(release, "go");
  await Promise.all(requests);

  expect((await readFile(codexLog, "utf8")).trim().split("\n")).toHaveLength(1);
  const branches = (
    await run(["git", "branch", "--list", "openbot/production-*"], repository)
  )
    .split("\n")
    .filter(Boolean);
  expect(branches).toHaveLength(1);
  expect(await productionWorktrees(repository)).toHaveLength(0);
  const [finished] = await database
    .select()
    .from(productionIssues)
    .where(eq(productionIssues.id, issue!.id));
  expect(finished).toMatchObject({
    fixStatus: "pull_request_open",
    pullRequestUrl: "https://github.com/example/fixture/pull/35",
  });
  expect(finished!.fixBranch).toStartWith("openbot/production-");
}, 60_000);

test("a later draft supersedes the failed fix's branch and PR in a durable audit row", async () => {
  const [issue] = await database
    .insert(productionIssues)
    .values({
      fingerprint: `supersede-${crypto.randomUUID()}`,
      title: "Supersede the failed fix",
      severity: "high",
      rootCause: "previous fix failed CI",
      fixStatus: "failed",
      fixBranch: "openbot/production-old-attempt",
      pullRequestUrl: "https://github.com/example/fixture/pull/9",
    })
    .returning();
  issueIds.push(issue!.id);
  const store = createProductionEngineerStore(
    database,
    async () => ({
      branch: "openbot/production-new-attempt",
      pullRequestUrl: "https://github.com/example/fixture/pull/10",
    }),
    createAuditStore(database),
  );

  await store.draftFix("admin-supersede", issue!.id);

  const events = await database
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.targetId, issue!.id));
  const superseded = events.find(
    (event) => event.eventType === "production.fix_superseded",
  );
  expect(superseded?.payload).toMatchObject({
    supersededBranch: "openbot/production-old-attempt",
    supersededPullRequestUrl: "https://github.com/example/fixture/pull/9",
  });
  const [row] = await database
    .select()
    .from(productionIssues)
    .where(eq(productionIssues.id, issue!.id));
  expect(row).toMatchObject({
    fixStatus: "pull_request_open",
    fixBranch: "openbot/production-new-attempt",
    pullRequestUrl: "https://github.com/example/fixture/pull/10",
  });
});
