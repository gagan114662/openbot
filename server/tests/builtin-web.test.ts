import { describe, expect, test } from "bun:test";
import { callTool, listTools } from "../src/plugins/builtin-web";

describe("builtin Open Web tools", () => {
  test("advertises the direct, credential-free tool set", async () => {
    expect((await listTools()).map((tool) => tool.name)).toEqual([
      "fetch_web_page",
      "extract_links",
      "get_json",
      "read_feed",
      "check_robots_txt",
    ]);
  });

  test.each([
    "http://127.0.0.1:5432",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/secret",
    "file:///etc/passwd",
  ])("refuses non-public target %s before fetching", async (url) => {
    const result = await callTool(
      { url: "builtin://open-web" },
      "fetch_web_page",
      { url },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(
      /not allowed|inside|cloud credentials|web address/i,
    );
  });

  test("does not accept a model-supplied credential as part of a URL", async () => {
    const result = await callTool({ url: "builtin://open-web" }, "get_json", {
      url: "https://user:password@example.com/data.json",
    });
    expect(result).toMatchObject({
      isError: true,
      text: "Web addresses containing credentials are refused.",
    });
  });
});
