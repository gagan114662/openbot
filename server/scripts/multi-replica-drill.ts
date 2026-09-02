import { existsSync } from "node:fs";

const ports = (process.env.OPENBOT_REPLICA_DRILL_PORTS ?? "3101,3102")
  .split(",")
  .map((value) => Number.parseInt(value, 10));
const requestCount = Number.parseInt(
  process.env.OPENBOT_REPLICA_DRILL_REQUESTS ?? "200",
  10,
);
const concurrency = Number.parseInt(
  process.env.OPENBOT_REPLICA_DRILL_CONCURRENCY ?? "20",
  10,
);
if (
  ports.length !== 2 ||
  ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65_535)
) {
  throw new Error("OPENBOT_REPLICA_DRILL_PORTS must name two usable ports");
}
if (!Number.isInteger(requestCount) || requestCount < 1) {
  throw new Error("OPENBOT_REPLICA_DRILL_REQUESTS must be a positive integer");
}
if (!Number.isInteger(concurrency) || concurrency < 1) {
  throw new Error(
    "OPENBOT_REPLICA_DRILL_CONCURRENCY must be a positive integer",
  );
}
const processes = ports.map((port) =>
  Bun.spawn(
    [
      "bun",
      ...(existsSync(".env") || existsSync("../.env")
        ? ["--env-file=../.env"]
        : []),
      "src/index.ts",
    ],
    {
      cwd: "server",
      env: { ...process.env, PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
    },
  ),
);

async function waitFor(port: number): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // A replica still starting is expected; the deadline below is the failure boundary.
    }
    await Bun.sleep(250);
  }
  throw new Error(`Replica on port ${port} did not become healthy`);
}

try {
  await Promise.all(ports.map(waitFor));
  const results: Array<{
    status: number;
    body: string;
    durationMs: number;
    error?: string;
  }> = [];
  for (let offset = 0; offset < requestCount; offset += concurrency) {
    const batch = await Promise.all(
      Array.from(
        { length: Math.min(concurrency, requestCount - offset) },
        async (_, batchIndex) => {
          const index = offset + batchIndex;
          const port = ports[index % ports.length];
          const startedAt = performance.now();
          try {
            const response = await fetch(
              `http://127.0.0.1:${port}/api/capabilities`,
            );
            return {
              status: response.status,
              body: await response.text(),
              durationMs: performance.now() - startedAt,
            };
          } catch (error) {
            return {
              status: 0,
              body: "",
              durationMs: performance.now() - startedAt,
              error: error instanceof Error ? error.message : "unknown error",
            };
          }
        },
      ),
    );
    results.push(...batch);
  }
  const failures = results.filter(
    (result) => result.status !== 200 || !result.body.includes("authProviders"),
  );
  if (failures.length > 0)
    throw new Error(`${failures.length} replica requests failed`);
  const durations = results
    .map((result) => result.durationMs)
    .sort((a, b) => a - b);
  const p95 = durations[Math.floor(durations.length * 0.95)] ?? 0;
  console.log(
    `Multi-replica drill passed: replicas=2 requests=${results.length} failures=0 p95_ms=${p95.toFixed(1)}`,
  );
} finally {
  for (const process of processes) process.kill();
  await Promise.all(processes.map((process) => process.exited));
}
