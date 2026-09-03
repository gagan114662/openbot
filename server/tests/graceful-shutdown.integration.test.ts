import { describe, expect, test } from "bun:test";

const moduleUrl = new URL("../src/shutdown.ts", import.meta.url).href;

async function child(script: string) {
  const process = Bun.spawn(["bun", "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = process.stdout.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain("ready");
  return { process, reader };
}

async function remaining(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let output = "";
  for (;;) {
    const part = await reader.read();
    if (part.done) return output;
    output += new TextDecoder().decode(part.value);
  }
}

describe("process shutdown", () => {
  test("a spawned process receiving SIGTERM waits for in-flight work before exiting", async () => {
    const running = await child(`
      import { installGracefulShutdown } from ${JSON.stringify(moduleUrl)};
      installGracefulShutdown({ timeoutMs: 1000, drain: async () => {
        console.log("drain-start");
        await new Promise(resolve => setTimeout(resolve, 120));
        console.log("drain-finished");
      }});
      console.log("ready");
      setInterval(() => {}, 1000);
    `);

    const started = Date.now();
    running.process.kill("SIGTERM");
    const output = await remaining(running.reader);
    const code = await running.process.exited;

    expect(code).toBe(0);
    expect(output).toContain("drain-start");
    expect(output).toContain("drain-finished");
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  test("a wedged drain cannot outlive the shutdown budget", async () => {
    const running = await child(`
      import { installGracefulShutdown } from ${JSON.stringify(moduleUrl)};
      installGracefulShutdown({ timeoutMs: 80, drain: async () => {
        console.log("drain-start");
        await new Promise(() => {});
      }});
      console.log("ready");
      setInterval(() => {}, 1000);
    `);

    const started = Date.now();
    running.process.kill("SIGTERM");
    const output = await remaining(running.reader);
    const code = await running.process.exited;

    expect(code).toBe(0);
    expect(output).toContain("drain-start");
    expect(Date.now() - started).toBeLessThan(500);
  });
});
