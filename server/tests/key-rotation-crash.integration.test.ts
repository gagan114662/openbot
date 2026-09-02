import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { encryptSecret, decryptSecret } from "../src/credentials";
import { createDatabase, type Database } from "../src/db/client";
import { credentials } from "../src/db/schema";

const sourceUrl = process.env.DATABASE_URL;
const run = async (
  command: string[],
  options: Parameters<typeof Bun.spawn>[1] = {},
) => {
  const child = Bun.spawn(command, {
    ...options,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(
      `${command.join(" ")} failed (${code}): ${stderr || stdout}`,
    );
  return stdout;
};

describe.skipIf(!sourceUrl)("crash-recoverable encryption-key rotation", () => {
  const databaseName = `openbot_rotation_${crypto.randomUUID().replaceAll("-", "")}`;
  let databaseUrl = "";
  let adminUrl = "";
  let database: Database;
  let directory = "";

  beforeAll(async () => {
    const parsed = new URL(sourceUrl!);
    parsed.pathname = "/postgres";
    adminUrl = parsed.toString();
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    await run(["createdb", "--maintenance-db", adminUrl, databaseName]);
    await run(
      ["bun", "x", "drizzle-kit", "migrate", "--config=drizzle.config.ts"],
      {
        cwd: join(process.cwd(), "server"),
        env: { ...process.env, DATABASE_URL: databaseUrl },
      },
    );
    database = createDatabase(databaseUrl, { max: 1 });
    directory = await mkdtemp(join(tmpdir(), "openbot-key-rotation-"));
  }, 30_000);

  afterAll(async () => {
    await database?.$client.close().catch(() => undefined);
    if (adminUrl)
      await run([
        "dropdb",
        "--maintenance-db",
        adminUrl,
        "--if-exists",
        databaseName,
      ]).catch(() => undefined);
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  test("a SIGKILL after commit leaves a durable key that the next run recovers", async () => {
    const oldKey = Buffer.alloc(32, 11).toString("base64");
    const envPath = join(directory, ".env");
    await writeFile(
      envPath,
      `DATABASE_URL=${databaseUrl}\nKEY_ENCRYPTION_KEY=${oldKey}\n`,
      { mode: 0o600 },
    );
    const [row] = await database
      .insert(credentials)
      .values({
        kind: "connector",
        provider: "crash-test",
        keyId: crypto.randomUUID(),
        metadata: {},
        encryptedValue: await encryptSecret(oldKey, "still-recoverable"),
      })
      .returning({ id: credentials.id });

    const child = Bun.spawn(
      [
        "bun",
        "server/scripts/rotate-encryption-key.ts",
        "--env-file",
        envPath,
        "--confirm-single-writer",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          KEY_ENCRYPTION_KEY: oldKey,
          OPENBOT_ROTATION_TEST_PAUSE_AFTER_COMMIT: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const reader = child.stdout.getReader();
    let output = "";
    while (!output.includes("ROTATION_TEST_AFTER_COMMIT")) {
      const part = await reader.read();
      if (part.done)
        throw new Error(`rotation exited before crash seam: ${output}`);
      output += new TextDecoder().decode(part.value);
    }
    child.kill(9);
    await child.exited;

    const pending = await readFile(`${envPath}.rotation-pending`, "utf8");
    const newKey = pending.match(/^KEY_ENCRYPTION_KEY=(.*)$/m)?.[1];
    expect(newKey).toBeTruthy();
    const [committed] = await database
      .select({ encryptedValue: credentials.encryptedValue })
      .from(credentials)
      .where(eq(credentials.id, row!.id));
    expect(await decryptSecret(newKey!, committed!.encryptedValue)).toBe(
      "still-recoverable",
    );

    const recovered = await run(
      [
        "bun",
        "server/scripts/rotate-encryption-key.ts",
        "--env-file",
        envPath,
        "--confirm-single-writer",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          KEY_ENCRYPTION_KEY: oldKey,
        },
      },
    );
    expect(recovered).toContain("Recovered a committed key rotation");
    expect(await readFile(envPath, "utf8")).toContain(
      `KEY_ENCRYPTION_KEY=${newKey}`,
    );
  }, 30_000);
});
