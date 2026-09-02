import { describe, expect, test } from "bun:test";
import { acquireSuiteLock } from "../scripts/test-suite-lock";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("the whole-suite database budget", () => {
  test("a competing suite fails once with a clear diagnostic and can start after release", async () => {
    const name = `openbot:test-lock:${crypto.randomUUID()}`;
    const first = await acquireSuiteLock(databaseUrl!, name);
    try {
      await expect(acquireSuiteLock(databaseUrl!, name)).rejects.toThrow(
        "Another `bun run test:ci` suite is already using this PostgreSQL database",
      );
    } finally {
      await first.release();
    }

    const after = await acquireSuiteLock(databaseUrl!, name);
    await after.release();
  });
});
