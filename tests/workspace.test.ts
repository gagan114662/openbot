import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");

function packageManifest(path: string) {
  return JSON.parse(
    readFileSync(join(repositoryRoot, path, "package.json"), "utf8"),
  ) as {
    name: string;
  };
}

describe("OpenBot workspace", () => {
  test("defines every root workspace package", () => {
    const rootManifest = JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8"),
    ) as { workspaces: string[] };

    expect(rootManifest.workspaces).toEqual([
      "app",
      "server",
      "worker",
      "agent-codex",
    ]);

    for (const packageName of rootManifest.workspaces) {
      expect(existsSync(join(repositoryRoot, packageName))).toBe(true);
      expect(packageManifest(packageName).name).toBe(
        packageName === "agent-codex" ? "@openbot/agent-codex" : packageName,
      );
    }
  });

  test("gives the production dependency install every workspace manifest", () => {
    const rootManifest = JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8"),
    ) as { workspaces: string[] };
    const dockerfile = readFileSync(join(repositoryRoot, "Dockerfile"), "utf8");

    for (const packageName of rootManifest.workspaces) {
      expect(dockerfile).toContain(
        `cp /src/${packageName}/package.json ${packageName}/package.json`,
      );
    }
  });

  test("ships cross-workspace runtime imports in the production image", () => {
    const dockerfile = readFileSync(join(repositoryRoot, "Dockerfile"), "utf8");

    expect(dockerfile).toContain("COPY agent-codex/src agent-codex/src");
    expect(dockerfile).toContain(
      "COPY agent-codex/package.json agent-codex/package.json",
    );
  });
});
