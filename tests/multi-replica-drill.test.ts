import { expect, test } from "bun:test";

test("the replica drill boots two real API processes and measures concurrent traffic", async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for the replica drill");
  }
  const reserve = () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    const port = server.port;
    server.stop(true);
    return port;
  };
  const ports = [reserve(), reserve()];
  const result = Bun.spawnSync(
    ["bun", "server/scripts/multi-replica-drill.ts"],
    {
      env: {
        ...process.env,
        OPENBOT_REPLICA_DRILL_PORTS: ports.join(","),
        OPENBOT_REPLICA_DRILL_REQUESTS: "24",
        OPENBOT_REPLICA_DRILL_CONCURRENCY: "6",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toMatch(
    /Multi-replica drill passed: replicas=2 requests=24 failures=0 p95_ms=\d+(?:\.\d+)?/,
  );
}, 60_000);
