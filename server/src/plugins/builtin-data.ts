import { MAX_RESULT_CHARS, type McpCallResult, type McpTool } from "./mcp";

const MAX_INPUT = 100_000;
const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "calculate",
    description:
      "Evaluate bounded arithmetic deterministically. Supports numbers, parentheses, +, -, *, / and %. Never executes code.",
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string", maxLength: 500 } },
      required: ["expression"],
    },
  },
  {
    name: "verify_money_total",
    description:
      "Recompute an integer-cent money total and emit a typed critical verifier contract. Use for invoices, revenue, adjustments, and reconciliations where an exact total must be independently checked.",
    inputSchema: {
      type: "object",
      properties: {
        lineItemCents: {
          type: "array",
          items: { type: "integer" },
          maxItems: 10_000,
        },
        reportedTotalCents: { type: "integer" },
      },
      required: ["lineItemCents", "reportedTotalCents"],
    },
  },
  {
    name: "convert_csv_json",
    description:
      "Convert bounded CSV with a header row to JSON, or a JSON array of flat objects to CSV. No upload or external service is used.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["csv_to_json", "json_to_csv"] },
        content: { type: "string", maxLength: MAX_INPUT },
      },
      required: ["format", "content"],
    },
  },
  {
    name: "time_in_zone",
    description:
      "Return the current ISO instant and a formatted local time for an IANA time zone. Invalid zones are refused.",
    inputSchema: {
      type: "object",
      properties: { timeZone: { type: "string", maxLength: 100 } },
      required: ["timeZone"],
    },
  },
]);

export const listNeedsCredential = false;
export async function listTools() {
  return TOOLS.map((tool) => ({ ...tool }));
}

const result = (value: unknown, isError = false): McpCallResult => {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return {
    text: text.slice(0, MAX_RESULT_CHARS),
    isError,
    truncated: text.length > MAX_RESULT_CHARS,
  };
};

class Arithmetic {
  private index = 0;
  constructor(private readonly source: string) {}
  parse() {
    const value = this.expression();
    this.space();
    if (this.index !== this.source.length || !Number.isFinite(value)) {
      throw new Error("The arithmetic expression is invalid or non-finite.");
    }
    return value;
  }
  private space() {
    while (/\s/.test(this.source[this.index] ?? "")) this.index += 1;
  }
  private expression(): number {
    let value = this.term();
    while (true) {
      this.space();
      const operator = this.source[this.index];
      if (operator !== "+" && operator !== "-") return value;
      this.index += 1;
      const right = this.term();
      value = operator === "+" ? value + right : value - right;
    }
  }
  private term(): number {
    let value = this.factor();
    while (true) {
      this.space();
      const operator = this.source[this.index];
      if (operator !== "*" && operator !== "/" && operator !== "%")
        return value;
      this.index += 1;
      const right = this.factor();
      if ((operator === "/" || operator === "%") && right === 0) {
        throw new Error("Division by zero is refused.");
      }
      value =
        operator === "*"
          ? value * right
          : operator === "/"
            ? value / right
            : value % right;
    }
  }
  private factor(): number {
    this.space();
    if (this.source[this.index] === "-") {
      this.index += 1;
      return -this.factor();
    }
    if (this.source[this.index] === "(") {
      this.index += 1;
      const value = this.expression();
      this.space();
      if (this.source[this.index] !== ")")
        throw new Error("A closing parenthesis is required.");
      this.index += 1;
      return value;
    }
    const match = this.source
      .slice(this.index)
      .match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
    if (!match) throw new Error("A number is required.");
    this.index += match[0].length;
    return Number(match[0]);
  }
}

function csvRows(content: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index <= content.length; index += 1) {
    const character = content[index] ?? "\n";
    if (quoted && character === '"' && content[index + 1] === '"') {
      field += '"';
      index += 1;
    } else if (character === '"') quoted = !quoted;
    else if (!quoted && character === ",") {
      row.push(field);
      field = "";
    } else if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && content[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field.");
  return rows;
}

const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

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
    if (toolName === "calculate") {
      const expression =
        typeof args.expression === "string" ? args.expression : "";
      if (!expression || expression.length > 500)
        throw new Error("A bounded expression is required.");
      return result({ expression, value: new Arithmetic(expression).parse() });
    }
    if (toolName === "verify_money_total") {
      const lineItemCents = Array.isArray(args.lineItemCents)
        ? args.lineItemCents
        : [];
      if (
        lineItemCents.length === 0 ||
        lineItemCents.length > 10_000 ||
        !lineItemCents.every(Number.isSafeInteger) ||
        !Number.isSafeInteger(args.reportedTotalCents)
      ) {
        throw new Error(
          "Integer-cent line items and a reported integer-cent total are required.",
        );
      }
      const computedTotalCents = lineItemCents.reduce(
        (total, cents) => total + Number(cents),
        0,
      );
      if (!Number.isSafeInteger(computedTotalCents)) {
        throw new Error("The computed money total exceeds the safe range.");
      }
      return result({
        computedTotalCents,
        matches: computedTotalCents === args.reportedTotalCents,
        openbotVerifier: {
          kind: "money-total",
          lineItemCents,
          reportedTotalCents: args.reportedTotalCents,
        },
      });
    }
    if (toolName === "time_in_zone") {
      const timeZone = typeof args.timeZone === "string" ? args.timeZone : "";
      if (!timeZone || timeZone.length > 100)
        throw new Error("An IANA time zone is required.");
      const now = new Date();
      return result({
        instant: now.toISOString(),
        timeZone,
        local: new Intl.DateTimeFormat("en-CA", {
          dateStyle: "full",
          timeStyle: "long",
          timeZone,
        }).format(now),
      });
    }
    if (toolName === "convert_csv_json") {
      const content = typeof args.content === "string" ? args.content : "";
      if (!content || content.length > MAX_INPUT)
        throw new Error(
          "Content is required and limited to 100,000 characters.",
        );
      if (args.format === "csv_to_json") {
        const [headers, ...rows] = csvRows(content);
        if (!headers || headers.length === 0)
          throw new Error("CSV needs a header row.");
        return result(
          rows.map((row) =>
            Object.fromEntries(
              headers.map((header, index) => [header, row[index] ?? ""]),
            ),
          ),
        );
      }
      if (args.format === "json_to_csv") {
        const parsed = JSON.parse(content) as unknown;
        if (
          !Array.isArray(parsed) ||
          parsed.some(
            (item) => !item || typeof item !== "object" || Array.isArray(item),
          )
        ) {
          throw new Error("JSON must be an array of flat objects.");
        }
        const headers = [
          ...new Set(
            parsed.flatMap((item) =>
              Object.keys(item as Record<string, unknown>),
            ),
          ),
        ];
        const lines = [
          headers.map(csvCell).join(","),
          ...parsed.map((item) =>
            headers
              .map((header) =>
                csvCell((item as Record<string, unknown>)[header]),
              )
              .join(","),
          ),
        ];
        return result(lines.join("\n"));
      }
      throw new Error("Format must be csv_to_json or json_to_csv.");
    }
    return result(`Unknown data utility: ${toolName}`, true);
  } catch (error) {
    return result(error instanceof Error ? error.message : String(error), true);
  }
}
