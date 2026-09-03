import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

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
const actual = createHash("sha256")
  .update(await readFile(path))
  .digest("hex");
if (actual !== expected)
  throw new Error(
    `Observable change ${relativePath} has SHA-256 ${actual}; expected ${expected}.`,
  );
console.log(`${relativePath} ${actual}`);
