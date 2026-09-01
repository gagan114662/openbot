import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("identity setup is atomic, complete, and keeps credentials out of arguments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openbot-identity-"));
  const envPath = join(directory, ".env");
  const clientSecret = "provider-secret-that-must-not-be-printed";
  try {
    await Bun.write(
      envPath,
      `OPENBOT_SINGLE_USER=true\nGOOGLE_OAUTH_CLIENT_ID=test-client\nGOOGLE_OAUTH_CLIENT_SECRET=${clientSecret}\n`,
    );
    const process = Bun.spawn(
      [
        "bun",
        "scripts/configure-identity.ts",
        "--provider",
        "google",
        "--admin",
        "admin@example.com",
        "--env-file",
        envPath,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [output, error, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(error).toBe("");
    expect(exitCode).toBe(0);
    expect(output).not.toContain(clientSecret);
    const configured = await Bun.file(envPath).text();
    expect(configured).toContain("OPENBOT_SINGLE_USER=false");
    expect(configured).toContain("BETTER_AUTH_URL=http://localhost:3001");
    expect(configured).toContain("TRUSTED_ORIGINS=http://localhost:3010");
    expect(configured).toContain("INITIAL_ADMIN_EMAILS=admin@example.com");
    expect(
      value(configured, "BETTER_AUTH_SECRET")?.length,
    ).toBeGreaterThanOrEqual(32);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function value(source: string, name: string): string | undefined {
  return source.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1];
}
