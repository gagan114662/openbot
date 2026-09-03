import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "bun";

const args = process.argv.slice(2);
const value = (flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const relativePath = value("--path");
const expected = value("--sha256");
if (!relativePath || !expected?.match(/^[a-f0-9]{64}$/))
  throw new Error("Usage: --path <relative-path> --sha256 <hex digest>");
const root = process.cwd();
const path = resolve(root, relativePath);
if (path === root || !path.startsWith(`${root}/`))
  throw new Error("Observable change path escapes the workflow worktree.");
const status = spawn(["git", "status", "--porcelain=v1", "--", relativePath], {
  cwd: root,
  stdout: "pipe",
  stderr: "pipe",
});
const [statusOutput, statusError, statusCode] = await Promise.all([
  new Response(status.stdout).text(),
  new Response(status.stderr).text(),
  status.exited,
]);
if (statusCode !== 0)
  throw new Error(`Could not inspect observable change: ${statusError.trim()}`);
if (!statusOutput.trim())
  throw new Error(
    `Observable path ${relativePath} was not changed by this run.`,
  );
const actual = createHash("sha256")
  .update(await readFile(path))
  .digest("hex");
if (actual !== expected)
  throw new Error(
    `Observable change ${relativePath} has SHA-256 ${actual}; expected ${expected}.`,
  );
console.log(`${relativePath} ${actual}`);
