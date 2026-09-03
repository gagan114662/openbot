/**
 * The test run, with a floor under how much of it must actually execute.
 *
 * A test file that throws while it is being imported never runs its tests and never reports them as
 * failures; the file is simply absent from the totals.
 *
 * This asserts the count as well as the result. A drop is treated as a failure, because a smaller
 * suite with no failure report gives false coverage.
 *
 * The floor is deliberately a floor and not an exact number. Tests are added constantly and a check
 * that has to be edited for every new test is a check people learn to edit without thinking.
 */

import { acquireSuiteLock, type SuiteLock } from "./test-suite-lock";
import { SQL } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MINIMUM_TESTS = 400;
const databaseUrl = process.env.DATABASE_URL?.trim();
let suiteLock: SuiteLock | undefined;
let testDatabase: { admin: SQL; name: string; url: string } | undefined;

if (databaseUrl) {
  try {
    suiteLock = await acquireSuiteLock(databaseUrl);
  } catch (error) {
    console.error(
      `\nTEST SUITE DID NOT START\n${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(73);
  }

  const source = new URL(databaseUrl);
  const name = `openbot_test_${process.pid}_${Date.now()}`;
  const adminUrl = new URL(source);
  adminUrl.pathname = "/postgres";
  const testUrl = new URL(source);
  testUrl.pathname = `/${name}`;
  const admin = new SQL(adminUrl.toString(), { max: 1 });
  try {
    await admin.unsafe(`create database "${name}"`);
    const migration = Bun.spawn(
      ["bun", "x", "drizzle-kit", "migrate", "--config=drizzle.config.ts"],
      {
        cwd: join(import.meta.dir, "..", "server"),
        env: { ...process.env, DATABASE_URL: testUrl.toString() },
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    if ((await migration.exited) !== 0) {
      throw new Error(
        "Schema migration failed for the disposable test database.",
      );
    }
    testDatabase = { admin, name, url: testUrl.toString() };
    console.error(`Test database: ${name} (disposable)`);
  } catch (error) {
    await admin
      .unsafe(`drop database if exists "${name}"`)
      .catch(() => undefined);
    await admin.close().catch(() => undefined);
    console.error(
      `\nTEST SUITE DID NOT START\nCould not create an isolated test database: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    await suiteLock.release();
    process.exit(74);
  }
}

async function finish(status: number): Promise<never> {
  if (testDatabase) {
    await testDatabase.admin`
      select pg_terminate_backend(pid)
      from pg_stat_activity
      where datname = ${testDatabase.name}
        and pid <> pg_backend_pid()
    `.catch(() => undefined);
    await testDatabase.admin
      .unsafe(`drop database if exists "${testDatabase.name}"`)
      .catch((error) =>
        console.error(
          `Disposable test database ${testDatabase?.name} could not be dropped: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    await testDatabase.admin.close().catch(() => undefined);
  }
  await suiteLock?.release();
  process.exit(status);
}

// `bun run test` rather than `bun test`, so the pretest hook fires and the generated application
// config exists before route imports need it.
const proc = Bun.spawn(["bun", "run", "test"], {
  env: {
    ...process.env,
    // The real two-process drill has its own required CI job. Running it inside Bun's broad,
    // concurrent file registration starves process startup and tests scheduler contention instead.
    OPENBOT_FULL_SUITE: "true",
    ...(testDatabase ? { DATABASE_URL: testDatabase.url } : {}),
  },
  stdout: "inherit",
  stderr: "pipe",
});

// Bun writes its summary to stderr, so it is captured and echoed rather than inherited.
const stderr = await new Response(proc.stderr).text();
process.stderr.write(stderr);

const status = await proc.exited;
if (status !== 0) await finish(status);

const ran = stderr.match(/Ran (\d+) tests? across/);
const count = ran ? Number.parseInt(ran[1] as string, 10) : 0;

if (!ran) {
  console.error(
    "\nCould not read how many tests ran from bun's output. Refusing to report a pass on a run that cannot be counted.",
  );
  await finish(1);
}

if (count < MINIMUM_TESTS) {
  console.error(
    `\n${count} tests ran, and at least ${MINIMUM_TESTS} were expected.\n\n` +
      "Every test passed, so this is not a failing test, it is a suite that got smaller. The usual\n" +
      "cause is a file that threw while being imported, which takes its tests with it and reports\n" +
      "nothing. Run `bun test` and look for an unhandled error between the file groups.\n\n" +
      `If tests were deliberately removed, lower MINIMUM_TESTS in scripts/test-ci.ts and say why.`,
  );
  await finish(1);
}

console.error(`\n${count} tests ran (floor ${MINIMUM_TESTS}).`);

const episodeDirectory = await mkdtemp(join(tmpdir(), "openbot-ci-episode-"));
const episodePath = join(episodeDirectory, "recorded.jsonl");
const recorder = Bun.spawn(["bun", "scripts/record-runtime-eval-episode.ts"], {
  stdout: "pipe",
  stderr: "inherit",
});
const recorded = await new Response(recorder.stdout).text();
if ((await recorder.exited) !== 0 || !recorded.trim()) {
  await rm(episodeDirectory, { recursive: true, force: true });
  await finish(1);
}
await Bun.write(episodePath, recorded);
const evals = Bun.spawn(
  ["bun", "run", "eval:golden", "--episodes", episodePath],
  {
    stdout: "inherit",
    stderr: "inherit",
  },
);
const evalStatus = await evals.exited;
await rm(episodeDirectory, { recursive: true, force: true });
if (evalStatus !== 0) await finish(evalStatus);
await finish(0);
