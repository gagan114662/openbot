import { expect, test } from "bun:test";

test("key rotation durably stages recovery before writes and requires single-writer mode", async () => {
  const source = await Bun.file(
    "server/scripts/rotate-encryption-key.ts",
  ).text();
  const decrypts = source.indexOf(
    "const credentialPlaintexts = await Promise.all",
  );
  const transaction = source.indexOf("await database.transaction");
  const environmentWrite = source.indexOf("await durableWrite(pendingPath");

  expect(decrypts).toBeGreaterThan(0);
  expect(transaction).toBeGreaterThan(decrypts);
  expect(decrypts).toBeGreaterThan(environmentWrite);
  expect(transaction).toBeGreaterThan(environmentWrite);
  expect(source).toContain("verification.map((row) => decryptSecret(newKey");
  expect(source).toContain('const dryRun = args.includes("--dry-run")');
  expect(source).toContain('args.includes("--confirm-single-writer")');
  expect(source).toContain("pg_try_advisory_lock");
  expect(source).toContain(
    "lock table credentials, sso_providers in access exclusive mode",
  );
  expect(source).toContain("await file.sync()");
  expect(source).toContain("Recovered a committed key rotation");
});
