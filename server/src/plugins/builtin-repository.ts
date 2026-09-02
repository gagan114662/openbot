import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { MAX_RESULT_CHARS, type McpCallResult, type McpTool } from "./mcp";

const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_READ_LINES = 400;
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "outputs",
]);
const TEXT_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);
const SECRET_EXTENSIONS = new Set([".key", ".p12", ".pem", ".pfx"]);

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "list_repository_files",
    description:
      "List readable source and documentation paths in this OpenBot checkout. Build outputs, dependencies, symlinks, environment files, and key material are excluded.",
    inputSchema: {
      type: "object",
      properties: {
        prefix: {
          type: "string",
          description: "Optional relative path prefix.",
        },
        limit: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
      },
    },
  },
  {
    name: "search_repository",
    description:
      "Search readable repository files for a literal string. Returns exact relative paths, line numbers, and bounded matching lines; use this before claiming blast radius or technical-debt impact.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Literal text to find." },
        prefix: {
          type: "string",
          description: "Optional relative path prefix.",
        },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
      },
      required: ["query"],
    },
  },
  {
    name: "trace_repository_terms",
    description:
      "Trace blast radius in one deterministic pass. Searches up to 10 related literal terms across every readable repository file and returns the complete bounded union of matching files, lines, and terms. Use this instead of repeated searches and per-file reads when assessing a symbol, schema field, API, migration, or technical-debt change.",
    inputSchema: {
      type: "object",
      properties: {
        terms: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: { type: "string" },
          description:
            "Related literal identifiers or phrases to trace together.",
        },
        prefix: {
          type: "string",
          description: "Optional relative path prefix.",
        },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 500 },
      },
      required: ["terms"],
    },
  },
  {
    name: "read_repository_file",
    description:
      "Read a bounded line range from one readable repository file by exact relative path. Absolute paths, traversal, symlinks, environment files, and key material are refused.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Exact repository-relative path.",
        },
        startLine: { type: "integer", minimum: 1, default: 1 },
        endLine: { type: "integer", minimum: 1 },
      },
      required: ["path"],
    },
  },
]);

export const listNeedsCredential = false;
export async function listTools(): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

const failure = (text: string): McpCallResult => ({
  text,
  isError: true,
  truncated: false,
});
function success(value: unknown): McpCallResult {
  const text = JSON.stringify(value, null, 2);
  return text.length <= MAX_RESULT_CHARS
    ? { text, isError: false, truncated: false }
    : {
        text: `${text.slice(0, MAX_RESULT_CHARS)}\n\n[truncated: ${text.length} characters]`,
        isError: false,
        truncated: true,
      };
}

function repositoryRoot(): string {
  return resolve(
    process.env.OPENBOT_REPOSITORY_ROOT?.trim() ||
      resolve(import.meta.dir, "../../.."),
  );
}

function secretPath(path: string): boolean {
  const name = basename(path).toLowerCase();
  return (
    name.startsWith(".env") ||
    name === ".netrc" ||
    name === ".npmrc" ||
    name === "id_ed25519" ||
    name === "id_rsa" ||
    SECRET_EXTENSIONS.has(extname(name))
  );
}

function readablePath(path: string): boolean {
  return !secretPath(path) && TEXT_EXTENSIONS.has(extname(path).toLowerCase());
}

function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child === "" ||
    (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))
  );
}

async function safeFile(
  given: string,
): Promise<{ absolute: string; path: string }> {
  if (!given.trim() || isAbsolute(given))
    throw new Error("A repository-relative path is required.");
  const root = await realpath(repositoryRoot());
  const candidate = resolve(root, given);
  if (!within(root, candidate))
    throw new Error("That path leaves the repository.");
  const absolute = await realpath(candidate);
  if (!within(root, absolute))
    throw new Error("That path leaves the repository through a link.");
  const stat = await lstat(absolute);
  const path = relative(root, absolute).split(sep).join("/");
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("That path is not a regular repository file.");
  if (!readablePath(path))
    throw new Error("That file type is excluded from repository evidence.");
  if (stat.size > MAX_FILE_BYTES)
    throw new Error("That file is larger than the 1 MB read limit.");
  return { absolute, path };
}

async function repositoryFiles(prefix = ""): Promise<string[]> {
  const root = await realpath(repositoryRoot());
  if (isAbsolute(prefix))
    throw new Error("The prefix must be repository-relative.");
  const normalizedPrefix = prefix
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
  if (normalizedPrefix === ".." || normalizedPrefix.startsWith("../")) {
    throw new Error("The prefix leaves the repository.");
  }
  const files: string[] = [];
  const walk = async (directory: string) => {
    if (files.length >= MAX_FILES) return;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      if (entry.isSymbolicLink()) continue;
      const absolute = resolve(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) await walk(absolute);
      } else if (
        entry.isFile() &&
        readablePath(path) &&
        (!normalizedPrefix || path.startsWith(normalizedPrefix))
      ) {
        const stat = await lstat(absolute);
        if (stat.size <= MAX_FILE_BYTES) files.push(path);
      }
    }
  };
  await walk(root);
  return files;
}

function integerArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
) {
  const value = args[key];
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : fallback;
}

export async function callTool(
  _connection: {
    url: string;
    token?: string;
    actorId?: string;
    botId?: string;
  },
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  try {
    if (toolName === "list_repository_files") {
      const prefix = typeof args.prefix === "string" ? args.prefix : "";
      const limit = Math.min(Math.max(integerArg(args, "limit", 200), 1), 1000);
      const files = await repositoryFiles(prefix);
      return success({
        files: files.slice(0, limit),
        truncated: files.length > limit,
      });
    }
    if (toolName === "search_repository") {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return failure("A literal search query is required.");
      if (query.length > 200)
        return failure("The search query is longer than 200 characters.");
      const prefix = typeof args.prefix === "string" ? args.prefix : "";
      const limit = Math.min(Math.max(integerArg(args, "limit", 100), 1), 200);
      const needle = query.toLowerCase();
      const matches: Array<{ path: string; line: number; text: string }> = [];
      for (const path of await repositoryFiles(prefix)) {
        const { absolute } = await safeFile(path);
        const lines = (await readFile(absolute, "utf8")).split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          if (!line.toLowerCase().includes(needle)) continue;
          matches.push({ path, line: index + 1, text: line.slice(0, 300) });
          if (matches.length >= limit) {
            return success({ query, matches, truncated: true });
          }
        }
      }
      return success({ query, matches, truncated: false });
    }
    if (toolName === "trace_repository_terms") {
      const terms = Array.isArray(args.terms)
        ? [
            ...new Set(
              args.terms
                .filter((value): value is string => typeof value === "string")
                .map((value) => value.trim())
                .filter(Boolean),
            ),
          ].slice(0, 10)
        : [];
      if (terms.length === 0)
        return failure("At least one literal term is required.");
      if (terms.some((term) => term.length > 200)) {
        return failure("Every trace term must be at most 200 characters.");
      }
      const prefix = typeof args.prefix === "string" ? args.prefix : "";
      const limit = Math.min(Math.max(integerArg(args, "limit", 500), 1), 500);
      const needles = terms.map((term) => ({
        term,
        lower: term.toLowerCase(),
      }));
      const byFile = new Map<
        string,
        Array<{ term: string; line: number; text: string }>
      >();
      let count = 0;
      let truncated = false;
      for (const path of await repositoryFiles(prefix)) {
        const { absolute } = await safeFile(path);
        const lines = (await readFile(absolute, "utf8")).split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const text = lines[index] ?? "";
          const lower = text.toLowerCase();
          for (const needle of needles) {
            if (!lower.includes(needle.lower)) continue;
            if (count >= limit) {
              truncated = true;
              break;
            }
            const matches = byFile.get(path) ?? [];
            matches.push({
              term: needle.term,
              line: index + 1,
              text: text.slice(0, 300),
            });
            byFile.set(path, matches);
            count += 1;
          }
          if (truncated) break;
        }
        if (truncated) break;
      }
      return success({
        terms,
        files: [...byFile].map(([path, matches]) => ({ path, matches })),
        matchCount: count,
        truncated,
      });
    }
    if (toolName === "read_repository_file") {
      const path = typeof args.path === "string" ? args.path : "";
      const file = await safeFile(path);
      const lines = (await readFile(file.absolute, "utf8")).split(/\r?\n/);
      const startLine = Math.min(
        Math.max(integerArg(args, "startLine", 1), 1),
        Math.max(lines.length, 1),
      );
      const requestedEnd = integerArg(
        args,
        "endLine",
        startLine + MAX_READ_LINES - 1,
      );
      const endLine = Math.min(
        Math.max(requestedEnd, startLine),
        startLine + MAX_READ_LINES - 1,
        lines.length,
      );
      return success({
        path: file.path,
        startLine,
        endLine,
        content: lines.slice(startLine - 1, endLine).join("\n"),
        truncated: endLine < lines.length,
      });
    }
    return failure(`There is no repository tool called ${toolName}.`);
  } catch (error) {
    return failure(
      error instanceof Error
        ? error.message
        : "Repository evidence could not be read.",
    );
  }
}
