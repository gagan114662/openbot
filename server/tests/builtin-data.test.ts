import { describe, expect, test } from "bun:test";
import { callTool, listTools } from "../src/plugins/builtin-data";

const connection = { url: "builtin://data-utilities" };

describe("credential-free data utilities", () => {
  test("evaluates arithmetic without JavaScript execution", async () => {
    const answer = await callTool(connection, "calculate", {
      expression: "(12 + 3) * 4 - 5",
    });
    expect(answer.isError).toBe(false);
    expect(JSON.parse(answer.text)).toMatchObject({ value: 55 });
    const attack = await callTool(connection, "calculate", {
      expression: "process.exit(1)",
    });
    expect(attack.isError).toBe(true);
  });

  test("round trips bounded CSV and JSON", async () => {
    const json = await callTool(connection, "convert_csv_json", {
      format: "csv_to_json",
      content: 'name,note\nAda,"hello, world"',
    });
    expect(JSON.parse(json.text)).toEqual([
      { name: "Ada", note: "hello, world" },
    ]);
    const csv = await callTool(connection, "convert_csv_json", {
      format: "json_to_csv",
      content: json.text,
    });
    expect(csv.text).toContain('Ada,"hello, world"');
  });

  test("emits a typed critical verifier contract for money totals", async () => {
    const answer = await callTool(connection, "verify_money_total", {
      lineItemCents: [1_000, 250, -50],
      reportedTotalCents: 1_200,
    });
    expect(answer.isError).toBe(false);
    expect(JSON.parse(answer.text)).toEqual({
      computedTotalCents: 1_200,
      matches: true,
      openbotVerifier: {
        kind: "money-total",
        lineItemCents: [1_000, 250, -50],
        reportedTotalCents: 1_200,
      },
    });
  });

  test("advertises only reviewed bounded tools", async () => {
    expect((await listTools()).map((tool) => tool.name)).toEqual([
      "calculate",
      "verify_money_total",
      "convert_csv_json",
      "time_in_zone",
    ]);
  });
});
