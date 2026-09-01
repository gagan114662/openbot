import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { credentials, ssoProviders } from "../src/db/schema";

const args = process.argv.slice(2);
const pathAt = args.indexOf("--env-file");
const envPath = resolve(pathAt >= 0 ? (args[pathAt + 1] ?? ".env") : ".env");
const dryRun = args.includes("--dry-run");
const oldKey = process.env.KEY_ENCRYPTION_KEY?.trim();
const databaseUrl = process.env.DATABASE_URL?.trim();
const newKey =
  process.env.NEW_KEY_ENCRYPTION_KEY?.trim() ??
  randomBytes(32).toString("base64");

function validKey(value: string | undefined): value is string {
  if (!value) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.byteLength === 32 && decoded.toString("base64") === value;
}

if (!validKey(oldKey))
  throw new Error("KEY_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
if (!validKey(newKey)) {
  throw new Error(
    "NEW_KEY_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
  );
}
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (newKey === oldKey)
  throw new Error("The new encryption key must differ from the current key");
const currentKey = oldKey;

function looksEncrypted(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return parsed.version === 1 && "iv" in parsed && "ciphertext" in parsed;
  } catch {
    return false;
  }
}

async function plaintext(value: string | null): Promise<string | null> {
  if (value === null) return null;
  if (!looksEncrypted(value)) return value;
  return decryptSecret(currentKey, value);
}

function replaceSetting(source: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  return pattern.test(source)
    ? source.replace(pattern, line)
    : `${source.replace(/\s*$/, "")}\n${line}\n`;
}

const database = createDatabase(databaseUrl, { max: 1 });

try {
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

  // Every decrypt happens before the first write. One unreadable row aborts without changing state.
  const credentialPlaintexts = await Promise.all(
    credentialRows.map(async (row) => ({
      id: row.id,
      value: await decryptSecret(currentKey, row.encryptedValue),
    })),
  );
  const providerPlaintexts = await Promise.all(
    providerRows.map(async (row) => ({
      id: row.id,
      oidcConfig: await plaintext(row.oidcConfig),
      samlConfig: await plaintext(row.samlConfig),
    })),
  );

  if (!dryRun) {
    await database.transaction(async (transaction) => {
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

    const verification = await database
      .select({ encryptedValue: credentials.encryptedValue })
      .from(credentials);
    await Promise.all(
      verification.map((row) => decryptSecret(newKey, row.encryptedValue)),
    );

    const source = await Bun.file(envPath).text();
    const next = replaceSetting(source, "KEY_ENCRYPTION_KEY", newKey);
    const temporary = `${envPath}.rotation-${process.pid}`;
    await Bun.write(temporary, next, { mode: 0o600 });
    await Bun.file(temporary).exists();
    await Bun.$`mv ${temporary} ${envPath}`.quiet();
  }

  console.log(
    `${dryRun ? "Validated" : "Rotated"} ${credentialRows.length} credential rows and ${providerRows.length} identity-provider rows.`,
  );
} finally {
  await database.$client.close();
}
