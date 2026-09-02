import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { credentials, ssoProviders } from "../src/db/schema";

const ROTATION_LOCK = "openbot:key-encryption-rotation:v1";
const args = process.argv.slice(2);
const pathAt = args.indexOf("--env-file");
const envPath = resolve(pathAt >= 0 ? (args[pathAt + 1] ?? ".env") : ".env");
const pendingPath = `${envPath}.rotation-pending`;
const dryRun = args.includes("--dry-run");
const singleWriter = args.includes("--confirm-single-writer");
const oldKey = process.env.KEY_ENCRYPTION_KEY?.trim();
const databaseUrl = process.env.DATABASE_URL?.trim();

function validKey(value: string | undefined): value is string {
  if (!value) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.byteLength === 32 && decoded.toString("base64") === value;
}

function setting(source: string, name: string): string | undefined {
  return source.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim();
}

function replaceSetting(source: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  return pattern.test(source)
    ? source.replace(pattern, line)
    : `${source.replace(/\s*$/, "")}\n${line}\n`;
}

async function syncDirectory(path: string) {
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function durableWrite(path: string, contents: string) {
  const file = await open(path, "w", 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(contents, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(path);
}

async function promotePendingEnvironment() {
  await rename(pendingPath, envPath);
  await syncDirectory(envPath);
}

if (!validKey(oldKey))
  throw new Error("KEY_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!dryRun && !singleWriter) {
  throw new Error(
    "Key rotation requires single-writer mode. Stop every OpenBot server replica, then rerun with --confirm-single-writer.",
  );
}
const currentKey = oldKey;
const source = await readFile(envPath, "utf8");
const pendingSource = await readFile(pendingPath, "utf8").catch(
  () => undefined,
);
const requestedKey = process.env.NEW_KEY_ENCRYPTION_KEY?.trim();
const pendingKey = pendingSource
  ? setting(pendingSource, "KEY_ENCRYPTION_KEY")
  : undefined;
const newKey = pendingKey ?? requestedKey ?? randomBytes(32).toString("base64");

if (!validKey(newKey))
  throw new Error(
    "NEW_KEY_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
  );
if (newKey === currentKey)
  throw new Error("The new encryption key must differ from the current key");

function looksEncrypted(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return parsed.version === 1 && "iv" in parsed && "ciphertext" in parsed;
  } catch {
    return false;
  }
}

async function plaintext(
  key: string,
  value: string | null,
): Promise<string | null> {
  if (value === null) return null;
  if (!looksEncrypted(value)) return value;
  return decryptSecret(key, value);
}

const database = createDatabase(databaseUrl, { max: 1 });

try {
  const [{ held }] = await database.execute<{ held: boolean }>(
    sql`select pg_try_advisory_lock(hashtext(${ROTATION_LOCK})) as held`,
  );
  if (!held)
    throw new Error(
      "Another key rotation is already running; no rows were changed.",
    );

  const credentialRows = await database
    .select({ id: credentials.id, encryptedValue: credentials.encryptedValue })
    .from(credentials);
  const providerRows = await database
    .select({
      id: ssoProviders.id,
      oidcConfig: ssoProviders.oidcConfig,
      samlConfig: ssoProviders.samlConfig,
    })
    .from(ssoProviders);

  // A pending file is a durable recovery key. If the prior process committed its DB transaction
  // and died before the rename, complete that rename without touching ciphertext again.
  if (pendingSource) {
    const recoverable = await Promise.all([
      ...credentialRows.map((row) => decryptSecret(newKey, row.encryptedValue)),
      ...providerRows.flatMap((row) => [
        plaintext(newKey, row.oidcConfig),
        plaintext(newKey, row.samlConfig),
      ]),
    ]).then(
      () => true,
      () => false,
    );
    if (recoverable) {
      await promotePendingEnvironment();
      console.log(`Recovered a committed key rotation from ${pendingPath}.`);
      process.exitCode = 0;
    } else {
      // The previous process died before commit. Reuse the already-durable key rather than minting
      // another one, then safely repeat the transaction from ciphertext still under currentKey.
      await Promise.all(
        credentialRows.map((row) =>
          decryptSecret(currentKey, row.encryptedValue),
        ),
      );
    }
  }

  if (process.exitCode !== 0 && !dryRun) {
    // Persist and fsync the complete replacement environment before the first database write. This
    // file is the recovery procedure after any crash following commit.
    if (!pendingSource) {
      await durableWrite(
        pendingPath,
        replaceSetting(source, "KEY_ENCRYPTION_KEY", newKey),
      );
    }

    const credentialPlaintexts = await Promise.all(
      credentialRows.map(async (row) => ({
        id: row.id,
        value: await decryptSecret(currentKey, row.encryptedValue),
      })),
    );
    const providerPlaintexts = await Promise.all(
      providerRows.map(async (row) => ({
        id: row.id,
        oidcConfig: await plaintext(currentKey, row.oidcConfig),
        samlConfig: await plaintext(currentKey, row.samlConfig),
      })),
    );

    await database.transaction(async (transaction) => {
      // Table locks plus the required stopped-replica mode prevent old-key writes interleaving with
      // this transaction. The advisory lock separately prevents two rotation operators racing.
      await transaction.execute(
        sql`lock table credentials, sso_providers in access exclusive mode`,
      );
      for (const row of credentialPlaintexts) {
        await transaction
          .update(credentials)
          .set({
            encryptedValue: await encryptSecret(newKey, row.value),
            updatedAt: new Date(),
          })
          .where(eq(credentials.id, row.id));
      }
      for (const row of providerPlaintexts) {
        await transaction
          .update(ssoProviders)
          .set({
            oidcConfig:
              row.oidcConfig === null
                ? null
                : await encryptSecret(newKey, row.oidcConfig),
            samlConfig:
              row.samlConfig === null
                ? null
                : await encryptSecret(newKey, row.samlConfig),
          })
          .where(eq(ssoProviders.id, row.id));
      }
    });

    // Test-only deterministic crash seam. It emits no key material and is inert unless explicitly set.
    if (process.env.OPENBOT_ROTATION_TEST_PAUSE_AFTER_COMMIT === "1") {
      console.log("ROTATION_TEST_AFTER_COMMIT");
      await new Promise(() => {});
    }

    const verification = await database
      .select({ encryptedValue: credentials.encryptedValue })
      .from(credentials);
    await Promise.all(
      verification.map((row) => decryptSecret(newKey, row.encryptedValue)),
    );
    await promotePendingEnvironment();
    console.log(
      `Rotated ${credentialRows.length} credential rows and ${providerRows.length} identity-provider rows.`,
    );
  } else if (dryRun) {
    await Promise.all(
      credentialRows.map((row) =>
        decryptSecret(currentKey, row.encryptedValue),
      ),
    );
    console.log(
      `Validated ${credentialRows.length} credential rows and ${providerRows.length} identity-provider rows.`,
    );
  }
} finally {
  await database
    .execute(sql`select pg_advisory_unlock(hashtext(${ROTATION_LOCK}))`)
    .catch(() => undefined);
  await database.$client.close();
  if (dryRun && !pendingSource)
    await unlink(pendingPath).catch(() => undefined);
}
