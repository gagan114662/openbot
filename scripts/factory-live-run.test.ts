import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("factory live-run proof tools", () => {
  test("observable verifier rejects a missing change and accepts exact bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-observable-"));
    roots.push(root);
    await writeFile(join(root, "PROOF.md"), "proved\n");
    const digest = new Bun.CryptoHasher("sha256")
      .update("proved\n")
      .digest("hex");
    const valid = Bun.spawnSync(
      [
        "bun",
        new URL("verify-observable-change.ts", import.meta.url).pathname,
        "--path",
        "PROOF.md",
        "--sha256",
        digest,
      ],
      { cwd: root },
    );
    expect(valid.exitCode).toBe(0);
    const invalid = Bun.spawnSync(
      [
        "bun",
        new URL("verify-observable-change.ts", import.meta.url).pathname,
        "--path",
        "PROOF.md",
        "--sha256",
        "0".repeat(64),
      ],
      { cwd: root },
    );
    expect(invalid.exitCode).not.toBe(0);
  });

  test("checked-in launcher sends its real arguments and never prints the session", async () => {
    let request: Record<string, unknown> | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(incoming) {
        request = (await incoming.json()) as Record<string, unknown>;
        return Response.json({ job: { id: "job-1" } }, { status: 201 });
      },
    });
    try {
      const child = Bun.spawn(
        [
          "bun",
          new URL("factory-live-run.ts", import.meta.url).pathname,
          "--base-url",
          server.url.toString().replace(/\/$/, ""),
          "--objective",
          "write exact proof",
          "--path",
          "PROOF.md",
          "--expected-content",
          "proved\n",
        ],
        {
          env: { ...process.env, OPENBOT_SESSION_COOKIE: "secret-session" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(request).toMatchObject({
        trigger: "factory-live-run",
        objective: "write exact proof",
        observableChange: { path: "PROOF.md", expectedContent: "proved\n" },
      });
      expect(output).not.toContain("secret-session");
    } finally {
      server.stop(true);
    }
  });
});
