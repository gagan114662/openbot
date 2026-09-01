import { expect, test } from "bun:test";

test("large frontend subsystems are emitted as cacheable chunks", async () => {
  const source = await Bun.file("app/vite.config.ts").text();
  for (const chunk of [
    'return "ag-ui"',
    'return "copilotkit-react"',
    'return "copilotkit-ui"',
    'return "copilotkit-runtime"',
    'return "tanstack"',
  ]) {
    expect(source).toContain(chunk);
  }
});
