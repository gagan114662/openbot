import { spawn } from "bun";
import type { DebtMetrics } from "../../shared/continuous-evolution";

export type DebtBudget = DebtMetrics;
export type DebtAssessment = {
  metrics: DebtMetrics;
  budget: DebtBudget;
  changedPaths: string[];
  violations: string[];
};

const CODE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php)$/i;
const DEPENDENCY_FILES =
  /(?:^|\/)(?:package\.json|bun\.lock|requirements[^/]*\.txt|pyproject\.toml|go\.mod|Cargo\.toml)$/;

async function output(command: string[], cwd: string): Promise<string> {
  const child = spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, status] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  if (status !== 0) return "";
  return stdout;
}

/** Snapshot paths, not content: the later assessment reads only artifacts this run changed. */
export async function changedPaths(cwd: string): Promise<string[]> {
  const status = await output(["git", "status", "--porcelain=v1", "-z"], cwd);
  return status
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3))
    .filter(Boolean)
    .sort();
}

function nonBlankLines(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function codeMetrics(text: string) {
  const lines = nonBlankLines(text);
  const seen = new Set<string>();
  let duplicatedLines = 0;
  for (const line of lines) {
    if (line.length < 24 || line === "{" || line === "}") continue;
    if (seen.has(line)) duplicatedLines += 1;
    else seen.add(line);
  }
  return {
    complexityPoints: [
      ...text.matchAll(/\b(?:if|else if|for|while|catch|case|&&|\|\|)\b/g),
    ].length,
    duplicatedLines,
    fileLines: text.split(/\r?\n/).length,
  };
}

export async function assessTechnicalDebt(input: {
  cwd: string;
  before: readonly string[];
  budget: DebtBudget;
}): Promise<DebtAssessment> {
  const after = await changedPaths(input.cwd);
  const beforeSet = new Set(input.before);
  const paths = after.filter((path) => !beforeSet.has(path));
  let complexityPoints = 0;
  let duplicatedLines = 0;
  let maximumFileLines = 0;

  for (const path of paths.filter((candidate) =>
    CODE_EXTENSIONS.test(candidate),
  )) {
    const file = Bun.file(`${input.cwd}/${path}`);
    if (!(await file.exists())) continue;
    const text = await file.text();
    const current = codeMetrics(text);
    // Modified legacy files are judged on debt added by this candidate, not debt that already
    // existed at HEAD. New files have no baseline and therefore remain fully accountable.
    const baselineText = await output(
      ["git", "show", `HEAD:${path}`],
      input.cwd,
    );
    const baseline = baselineText
      ? codeMetrics(baselineText)
      : { complexityPoints: 0, duplicatedLines: 0, fileLines: 0 };
    complexityPoints += Math.max(
      0,
      current.complexityPoints - baseline.complexityPoints,
    );
    duplicatedLines += Math.max(
      0,
      current.duplicatedLines - baseline.duplicatedLines,
    );
    maximumFileLines = Math.max(
      maximumFileLines,
      baselineText
        ? Math.max(0, current.fileLines - baseline.fileLines)
        : current.fileLines,
    );
  }

  const metrics: DebtMetrics = {
    addedDependencies: paths.filter((path) => DEPENDENCY_FILES.test(path))
      .length,
    complexityPoints,
    duplicatedLines,
    maximumFileLines,
  };
  const violations = (Object.keys(metrics) as Array<keyof DebtMetrics>).flatMap(
    (metric) =>
      metrics[metric] > input.budget[metric]
        ? [`${metric} ${metrics[metric]} exceeds ${input.budget[metric]}`]
        : [],
  );
  return { metrics, budget: input.budget, changedPaths: paths, violations };
}

export function debtBudgetFromEnvironment(
  environment: Record<string, string | undefined>,
): DebtBudget {
  const value = (name: string, fallback: number) => {
    const parsed = Number(environment[name]);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    addedDependencies: value("CODEX_DEBT_MAX_DEPENDENCIES", 0),
    complexityPoints: value("CODEX_DEBT_MAX_COMPLEXITY", 80),
    duplicatedLines: value("CODEX_DEBT_MAX_DUPLICATED_LINES", 20),
    maximumFileLines: value("CODEX_DEBT_MAX_FILE_LINES", 800),
  };
}
