import { expect, test } from "bun:test";

test("backup automation proves a restore in a disposable database", async () => {
  const source = await Bun.file("server/scripts/database-backup.ts").text();
  expect(source).toContain("pg_dump --format=custom");
  expect(source).toContain("pg_restore --exit-on-error");
  expect(source).toContain("openbot_restore_");
  expect(source).toContain("dropdb --maintenance-db=");
  expect(source).toContain("database.$count(credentials)");
  expect(source).toContain('createHash("sha256")');
});
