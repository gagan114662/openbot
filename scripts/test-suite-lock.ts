import { SQL } from "bun";

export const DEFAULT_SUITE_LOCK = "openbot:test-ci:v1";

export type SuiteLock = { release: () => Promise<void> };

export async function acquireSuiteLock(
  databaseUrl: string,
  lockName = DEFAULT_SUITE_LOCK,
): Promise<SuiteLock> {
  const client = new SQL(databaseUrl, { max: 1 });
  try {
    const [row] = await client<{ held: boolean }[]>`
      select pg_try_advisory_lock(hashtext(${lockName})) as held
    `;
    if (!row?.held) {
      await client.close();
      throw new Error(
        "Another `bun run test:ci` suite is already using this PostgreSQL database. Wait for it to finish instead of starting a competing run.",
      );
    }
  } catch (error) {
    await client.close().catch(() => undefined);
    const detail = error instanceof Error ? error.message : String(error);
    if (/too many clients|remaining connection slots|53300/i.test(detail)) {
      throw new Error(
        "PostgreSQL has exhausted its connection budget before the test suite could start. Stop duplicate suites or stale dev processes, then retry.",
      );
    }
    throw error;
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await client`select pg_advisory_unlock(hashtext(${lockName}))`;
      await client.close();
    },
  };
}
