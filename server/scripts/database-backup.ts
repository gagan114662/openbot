import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createDatabase } from "../src/db/client";
import { auditEvents, credentials, users } from "../src/db/schema";

const mode = process.argv[2] ?? "create";
const databaseUrl = process.env.DATABASE_URL?.trim();
const backupDirectory = resolve(process.env.OPENBOT_BACKUP_DIR ?? ".backups");
const offsiteUri = process.env.OPENBOT_BACKUP_OFFSITE_URI?.trim();
const retentionDays = Number(process.env.OPENBOT_BACKUP_RETENTION_DAYS ?? "30");
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!new Set(["create", "drill"]).has(mode)) {
  throw new Error("Usage: database-backup.ts create|drill [backup.dump]");
}

await mkdir(backupDirectory, { recursive: true, mode: 0o700 });

async function localPostgresContainer(): Promise<string | null> {
  try {
    const result = await Bun.$`docker compose ps -q postgres`.quiet();
    return result.text().trim() || null;
  } catch {
    return null;
  }
}

async function latestBackup(): Promise<string> {
  const files = (await readdir(backupDirectory))
    .filter((name) => name.endsWith(".dump"))
    .sort();
  const latest = files.at(-1);
  if (!latest) throw new Error("No backup exists to restore");
  return resolve(backupDirectory, latest);
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function uploadOffsite(path: string): Promise<void> {
  if (!offsiteUri) return;
  if (!offsiteUri.startsWith("s3://") && !offsiteUri.startsWith("r2://")) {
    throw new Error("OPENBOT_BACKUP_OFFSITE_URI must be an s3:// or r2:// URI");
  }
  const objectName = basename(path);
  const destination = `${offsiteUri.replace(/\/$/, "")}/${objectName}`;
  const verificationDirectory = await mkdtemp(
    join(tmpdir(), "openbot-offsite-verify-"),
  );
  const downloaded = join(verificationDirectory, objectName);
  try {
    if (offsiteUri.startsWith("s3://")) {
      await Bun.$`aws s3 cp ${path} ${destination} --only-show-errors`.quiet();
      await Bun.$`aws s3 cp ${destination} ${downloaded} --only-show-errors`.quiet();
    } else {
      const remote = new URL(destination);
      const objectPath = `${remote.hostname}${remote.pathname}`;
      await Bun.$`wrangler r2 object put ${objectPath} --file ${path} --remote`.quiet();
      await Bun.$`wrangler r2 object get ${objectPath} --file ${downloaded} --remote`.quiet();
    }
    if ((await sha256(downloaded)) !== (await sha256(path))) {
      throw new Error(`Offsite verification failed for ${objectName}`);
    }
  } finally {
    await rm(verificationDirectory, { recursive: true, force: true });
  }
}

async function enforceLocalRetention(now = Date.now()): Promise<void> {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error("OPENBOT_BACKUP_RETENTION_DAYS must be a positive integer");
  }
  for (const name of await readdir(backupDirectory)) {
    if (!name.endsWith(".dump") && !name.endsWith(".dump.json")) continue;
    const path = resolve(backupDirectory, name);
    if (now - (await stat(path)).mtimeMs > retentionDays * 86_400_000)
      await rm(path);
  }
}

async function recordOperationsEvent(
  eventType: "operations.backup_verified" | "operations.restore_drill_verified",
  targetId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const database = createDatabase(databaseUrl as string, { max: 1 });
  try {
    await database.insert(auditEvents).values({
      eventType,
      targetType: "backup",
      targetId,
      payload,
    });
  } finally {
    await database.$client.close();
  }
}

if (mode === "create") {
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const output = resolve(backupDirectory, `openbot-${stamp}.dump`);
  const container = await localPostgresContainer();
  if (container) {
    const target = new URL(databaseUrl);
    const child = Bun.spawn(
      [
        "docker",
        "exec",
        container,
        "pg_dump",
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        `--username=${decodeURIComponent(target.username)}`,
        `--dbname=${target.pathname.slice(1)}`,
      ],
      { stdout: Bun.file(output), stderr: "pipe" },
    );
    const code = await child.exited;
    if (code !== 0)
      throw new Error(
        (await new Response(child.stderr).text()).trim() || "pg_dump failed",
      );
  } else {
    await Bun.$`pg_dump --format=custom --no-owner --no-privileges --file=${output} ${databaseUrl}`.quiet();
  }
  await chmod(output, 0o600);
  const bytes = (await stat(output)).size;
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    file: output.split("/").at(-1),
    bytes,
    sha256: await sha256(output),
  };
  await Bun.write(`${output}.json`, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(`${output}.json`, 0o600);
  await uploadOffsite(output);
  await uploadOffsite(`${output}.json`);
  await enforceLocalRetention();
  await recordOperationsEvent("operations.backup_verified", basename(output), {
    bytes,
    offsite: offsiteUri ? new URL(offsiteUri).protocol.slice(0, -1) : false,
    manifestVerified: true,
  });
  console.log(output);
} else {
  const backup = resolve(process.argv[3] ?? (await latestBackup()));
  if (!(await Bun.file(backup).exists()))
    throw new Error("Backup file does not exist");

  const source = new URL(databaseUrl);
  const admin = new URL(source);
  admin.pathname = "/postgres";
  const drillName = `openbot_restore_${randomUUID().replaceAll("-", "")}`;
  const drill = new URL(source);
  drill.pathname = `/${drillName}`;

  await Bun.$`createdb --maintenance-db=${admin.toString()} ${drillName}`.quiet();
  try {
    const container = await localPostgresContainer();
    if (container) {
      const containerBackup = `/tmp/${drillName}.dump`;
      await Bun.$`docker cp ${backup} ${`${container}:${containerBackup}`}`.quiet();
      try {
        await Bun.$`docker exec ${container} pg_restore --exit-on-error --no-owner --no-privileges --username=${decodeURIComponent(source.username)} --dbname=${drillName} ${containerBackup}`.quiet();
      } finally {
        await Bun.$`docker exec ${container} rm -f ${containerBackup}`.quiet();
      }
    } else {
      await Bun.$`pg_restore --exit-on-error --no-owner --no-privileges --dbname=${drill.toString()} ${backup}`.quiet();
    }
    const database = createDatabase(drill.toString(), { max: 1 });
    try {
      const [userRows, credentialRows, auditRows] = await Promise.all([
        database.$count(users),
        database.$count(credentials),
        database.$count(auditEvents),
      ]);
      console.log(
        `Restore drill passed: users=${userRows}, credentials=${credentialRows}, audit_events=${auditRows}`,
      );
      await recordOperationsEvent(
        "operations.restore_drill_verified",
        basename(backup),
        {
          users: userRows,
          credentials: credentialRows,
          auditEvents: auditRows,
        },
      );
    } finally {
      await database.$client.close();
    }
  } finally {
    await Bun.$`dropdb --maintenance-db=${admin.toString()} --if-exists ${drillName}`.quiet();
  }
}
