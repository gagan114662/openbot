import type { ManagedJobKind } from "./orchestrator";

export const factoryBenchmarkCatalog = {
  "ci-repair-v1": {
    id: "ci-repair-v1",
    kind: "ci-repair" as ManagedJobKind,
    objective:
      "Create benchmark-proof.txt with a non-empty explanation of one concrete invariant protected by the software-factory runtime. Do not modify product configuration or tests.",
    pairs: [
      { harness: "codex" as const, model: "gpt-5.6-luna" },
      { harness: "claude" as const, model: "sonnet" },
    ],
    checks: [
      {
        id: "observable-change-negative-control",
        command: [
          "bun",
          "-e",
          "const text=await Bun.file('benchmark-proof.txt').text();if(text.trim().length<40)process.exit(1)",
        ],
        timeoutMs: 30_000,
        required: true,
      },
      {
        id: "diff-integrity",
        command: ["git", "diff", "--check"],
        timeoutMs: 30_000,
        required: true,
      },
      {
        id: "router-tests",
        command: [
          "bun",
          "test",
          "server/src/software-factory/model-router.test.ts",
        ],
        timeoutMs: 120_000,
        required: true,
      },
      {
        id: "factory-route-tests",
        command: ["bun", "test", "server/src/software-factory/routes.test.ts"],
        timeoutMs: 120_000,
        required: true,
      },
      {
        id: "server-typecheck",
        command: ["bun", "run", "--cwd", "server", "typecheck"],
        timeoutMs: 120_000,
        required: true,
      },
      {
        id: "repository-lint",
        command: ["bun", "run", "lint"],
        timeoutMs: 120_000,
        required: true,
      },
    ],
  },
} as const;

export type FactoryBenchmarkId = keyof typeof factoryBenchmarkCatalog;
