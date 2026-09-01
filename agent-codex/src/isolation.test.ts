import { expect, test } from "bun:test";

test("the subscription adapter is loopback-only and denies child processes on macOS", async () => {
  const source = await Bun.file("agent-codex/src/index.ts").text();
  expect(source).toContain('hostname: "127.0.0.1"');
  expect(source).toContain('"(deny process-exec)"');
  expect(source).toContain("Resources/codex-code-mode-host");
  expect(source).toContain('"shell_environment_policy.inherit=none"');
  expect(source).toContain('process.env.CODEX_OS_SANDBOX !== "off"');
  expect(source).toContain('"/tmp/openbot-codex-adapter"');
  expect(source).toContain("CODEX_ALLOW_SECRET_TOOL_ARGS");
  expect(source).toContain(
    'findings.every((finding) => finding.category === "secret")',
  );
  expect(source).toContain("secretToolArguments: ALLOW_SECRET_TOOL_ARGS");
});
