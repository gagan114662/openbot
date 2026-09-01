import { expect, test } from "bun:test";

test("key rotation validates all ciphertext before its transaction writes", async () => {
  const source = await Bun.file(
    "server/scripts/rotate-encryption-key.ts",
  ).text();
  const decrypts = source.indexOf(
    "const credentialPlaintexts = await Promise.all",
  );
  const transaction = source.indexOf("await database.transaction");
  const environmentWrite = source.indexOf("await Bun.write");

  expect(decrypts).toBeGreaterThan(0);
  expect(transaction).toBeGreaterThan(decrypts);
  expect(environmentWrite).toBeGreaterThan(transaction);
  expect(source).toContain("verification.map((row) => decryptSecret(newKey");
  expect(source).toContain('const dryRun = args.includes("--dry-run")');
});
