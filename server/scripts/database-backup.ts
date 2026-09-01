import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createDatabase } from "../src/db/client";
import { auditEvents, credentials, users } from "../src/db/schema";

const mode = process.argv[2] ?? "create";
const databaseUrl = process.env.DATABASE_URL?.trim();
const backupDirectory = resolve(process.env.OPENBOT_BACKUP_DIR ?? ".backups");
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

if (mode === "create") {
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const output = resolve(backupDirectory, `openbot-${stamp}.dump`);
  const container = await localPostgresContainer();
  if (container) {
    const target = new URL(databaseUrl);
    const dump =
      await Bun.$`docker exec ${container} pg_dump --format=custom --no-owner --no-privileges --username=${decodeURIComponent(target.username)} --dbname=${target.pathname.slice(1)}`.quiet();
    await Bun.write(output, dump.arrayBuffer(), { mode: 0o600 });
  } else {
    await Bun.$`pg_dump --format=custom --no-owner --no-privileges --file=${output} ${databaseUrl}`.quiet();
  }
  const bytes = await Bun.file(output).arrayBuffer();
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    file: output.split("/").at(-1),
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(Buffer.from(bytes)).digest("hex"),
  };
  await Bun.write(`${output}.json`, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
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
    } finally {
      await database.$client.close();
    }
  } finally {
    await Bun.$`dropdb --maintenance-db=${admin.toString()} --if-exists ${drillName}`.quiet();
  }
}
