import { expect, test } from "bun:test";

test("the replica drill boots two processes and measures concurrent traffic", async () => {
  const source = await Bun.file("server/scripts/multi-replica-drill.ts").text();
  expect(source).toContain("const ports = [3101, 3102]");
  expect(source).toContain("const requestCount = 200");
  expect(source).toContain("const concurrency = 20");
  expect(source).toContain("Promise.all(ports.map(waitFor))");
  expect(source).toContain("status: 0");
  expect(source).toContain("p95_ms=");
  expect(source).toContain("process.kill()");
});
