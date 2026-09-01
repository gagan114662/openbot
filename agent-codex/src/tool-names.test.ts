import { describe, expect, test } from "bun:test";
import { codexToolAlias, codexToolNames } from "./tool-names";

describe("Codex deployment tool aliases", () => {
  test("does not expose OpenBot tools through Codex's reserved MCP namespace", () => {
    const original = "mcp__open-web__fetch_web_page";
    const alias = codexToolAlias(original);
    expect(alias).toMatch(/^openbot_[A-Za-z0-9_]+_[0-9a-f]{8}$/);
    expect(alias).not.toStartWith("mcp__");
    expect(codexToolNames([original]).originalByAlias.get(alias)).toBe(
      original,
    );
  });

  test("keeps similar sanitized names distinct", () => {
    expect(codexToolAlias("mcp__a-b__read")).not.toBe(
      codexToolAlias("mcp__a_b__read"),
    );
  });
});
