import { afterAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(
    directories.map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("backup automation streams a dump and restores it into a disposable database", async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for the recovery drill");
  }
  const directory = await mkdtemp(join(tmpdir(), "openbot-backup-test-"));
  directories.push(directory);
  const bin = join(directory, "bin");
  await Bun.$`mkdir -p ${bin}`;
  const uploadLog = join(directory, "offsite-uploads.log");
  const remote = join(directory, "remote");
  await Bun.$`mkdir -p ${remote}`;
  const aws = join(bin, "aws");
  await Bun.write(
    aws,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${uploadLog}"
if [ -f "$3" ]; then
  cp "$3" "${remote}/$(basename "$4")"
else
  cp "${remote}/$(basename "$3")" "$4"
fi
`,
  );
  await chmod(aws, 0o700);
  const environment = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    OPENBOT_BACKUP_DIR: directory,
    OPENBOT_BACKUP_OFFSITE_URI: "s3://off-host-proof/openbot",
  };

  const created = Bun.spawnSync(
    ["bun", "server/scripts/database-backup.ts", "create"],
    { env: environment, stdout: "pipe", stderr: "pipe" },
  );
  expect(created.exitCode, created.stderr.toString()).toBe(0);
  const dump = (await readdir(directory)).find((name) =>
    name.endsWith(".dump"),
  );
  expect(dump).toBeDefined();
  const dumpPath = join(directory, dump as string);
  expect((await stat(dumpPath)).size).toBeGreaterThan(0);
  expect((await stat(dumpPath)).mode & 0o777).toBe(0o600);
  expect((await stat(`${dumpPath}.json`)).mode & 0o777).toBe(0o600);
  const uploads = await readFile(uploadLog, "utf8");
  expect(uploads).toContain(`s3 cp ${dumpPath} s3://off-host-proof/openbot/`);
  expect(uploads).toContain(
    `s3 cp ${dumpPath}.json s3://off-host-proof/openbot/`,
  );
  expect(uploads.match(/s3 cp/g)).toHaveLength(4);

  const restored = Bun.spawnSync(
    ["bun", "server/scripts/database-backup.ts", "drill", dumpPath],
    { env: environment, stdout: "pipe", stderr: "pipe" },
  );
  expect(restored.exitCode, restored.stderr.toString()).toBe(0);
  expect(restored.stdout.toString()).toMatch(
    /Restore drill passed: users=\d+, credentials=\d+, audit_events=\d+/,
  );
}, 30_000);
