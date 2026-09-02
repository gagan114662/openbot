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
        // The drill boots the real composition root. CI intentionally has no deployment secrets,
        // so give only these disposable child processes a syntactically valid, process-local key.
        KEY_ENCRYPTION_KEY:
          process.env.KEY_ENCRYPTION_KEY ??
          Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
            "base64",
          ),
        INTELLIGENCE_API_URL:
          process.env.INTELLIGENCE_API_URL ??
          "https://api.intelligence.copilotkit.ai",
        INTELLIGENCE_GATEWAY_WS_URL:
          process.env.INTELLIGENCE_GATEWAY_WS_URL ??
          "wss://realtime.intelligence.copilotkit.ai",
        INTELLIGENCE_API_KEY:
          process.env.INTELLIGENCE_API_KEY ?? "ci-not-a-real-key",
        COPILOTKIT_LICENSE_TOKEN:
          process.env.COPILOTKIT_LICENSE_TOKEN ?? "ci-not-a-real-licence",
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
