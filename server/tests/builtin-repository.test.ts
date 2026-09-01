import { describe, expect, test } from "bun:test";
import { callTool, listTools } from "../src/plugins/builtin-repository";

describe("builtin repository evidence", () => {
  test("advertises only bounded read operations", async () => {
    expect((await listTools()).map((tool) => tool.name)).toEqual([
      "list_repository_files",
      "search_repository",
      "trace_repository_terms",
      "read_repository_file",
    ]);
  });

  test("traces related impact terms in one repository pass", async () => {
    const result = await callTool(
      { url: "builtin://repository" },
      "trace_repository_terms",
      {
        terms: ["humanWaitMs", "activeLatencyMs", "avgActiveLatencyMs"],
        limit: 100,
      },
    );
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.text) as {
      files: Array<{ path: string }>;
      truncated: boolean;
    };
    expect(body.truncated).toBe(false);
    expect(body.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "app/src/components/channels/channel-chat.tsx",
        "app/src/lib/analytics/queries.ts",
        "app/src/lib/analytics/turns.ts",
        "app/src/routes/_authed/admin/analytics.tsx",
        "server/src/analytics/store.ts",
      ]),
    );
  });

  test("finds exact source evidence with paths and line numbers", async () => {
    const result = await callTool(
      { url: "builtin://repository" },
      "search_repository",
      { query: "humanWaitMs", prefix: "app/src", limit: 20 },
    );
    expect(result.isError).toBe(false);
    expect(result.text).toContain("app/src/lib/analytics/turns.ts");
    expect(result.text).toContain('"line"');
  });

  test.each(["../.env", ".env", "/etc/passwd"])(
    "refuses secret or escaping path %s",
    async (path) => {
      const result = await callTool(
        { url: "builtin://repository" },
        "read_repository_file",
        { path },
      );
      expect(result.isError).toBe(true);
    },
  );

  test("reads only the requested bounded range", async () => {
    const result = await callTool(
      { url: "builtin://repository" },
      "read_repository_file",
      { path: "server/src/analytics/store.ts", startLine: 1, endLine: 3 },
    );
    expect(result).toMatchObject({ isError: false });
    const body = JSON.parse(result.text) as { startLine: number; endLine: number };
    expect(body).toMatchObject({ startLine: 1, endLine: 3 });
  });
});
