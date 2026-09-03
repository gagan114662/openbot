import type { ManagedJobKind } from "./orchestrator";

export const factoryBenchmarkCatalog = {
  "ci-repair-v1": {
    id: "ci-repair-v1",
    kind: "ci-repair" as ManagedJobKind,
    objective:
      "Inspect the fixed repository revision without changing product behavior; let the runtime execute the benchmark checks.",
    pairs: [
      { harness: "codex" as const, model: "gpt-5.6-luna" },
      { harness: "claude" as const, model: "sonnet" },
    ],
    checks: [
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
