import { describe, expect, test } from "bun:test";
import {
  toolRefFromModelName,
  verifyToolExecution,
} from "../src/analytics/tool-verifier";

describe("analytics tool execution verifier", () => {
  test("requires one signed success row for every observed call", () => {
    expect(
      verifyToolExecution(
        ["open-web/fetch_web_page", "open-web/fetch_web_page"],
        [
          {
            id: "audit-1",
            targetId: "open-web/fetch_web_page",
            eventType: "mcp.call_succeeded",
          },
        ],
      ),
    ).toEqual({
      passed: false,
      observed: ["open-web/fetch_web_page", "open-web/fetch_web_page"],
      matched: ["open-web/fetch_web_page"],
      unmatched: ["open-web/fetch_web_page"],
      operationalFailures: [],
      unresolvedOperationalFailures: [],
      rejected: [],
      auditEventIds: ["audit-1"],
    });
  });

  test("passes with exact multiset evidence and ignores unrelated rows", () => {
    const result = verifyToolExecution(
      ["open-web/fetch_web_page"],
      [
        {
          id: "other",
          targetId: "google-drive/search_files",
          eventType: "mcp.call_succeeded",
        },
        {
          id: "proof",
          targetId: "open-web/fetch_web_page",
          eventType: "mcp.call_succeeded",
        },
      ],
    );
    expect(result.passed).toBe(true);
    expect(result.auditEventIds).toEqual(["proof"]);
  });

  test("separates proof integrity from the audited tool outcome", () => {
    const failed = verifyToolExecution(
      ["open-web/fetch_web_page"],
      [
        {
          id: "failure-proof",
          targetId: "open-web/fetch_web_page",
          eventType: "mcp.call_failed",
        },
      ],
    );
    expect(failed.passed).toBe(true);
    expect(failed.operationalFailures).toEqual(["open-web/fetch_web_page"]);
    expect(failed.unresolvedOperationalFailures).toEqual([
      "open-web/fetch_web_page",
    ]);

    const rejected = verifyToolExecution(
      ["open-web/fetch_web_page"],
      [
        {
          id: "rejection-proof",
          targetId: "open-web/fetch_web_page",
          eventType: "mcp.call_rejected",
        },
      ],
    );
    expect(rejected.passed).toBe(true);
    expect(rejected.rejected).toEqual(["open-web/fetch_web_page"]);
    expect(rejected.operationalFailures).toEqual([]);
    expect(rejected.unresolvedOperationalFailures).toEqual([]);
  });

  test("distinguishes a recovered miss from a terminal tool failure", () => {
    const recovered = verifyToolExecution(
      ["repository/read_file", "repository/search", "repository/read_file"],
      [
        {
          id: "miss",
          targetId: "repository/read_file",
          eventType: "mcp.call_failed",
        },
        {
          id: "search",
          targetId: "repository/search",
          eventType: "mcp.call_succeeded",
        },
        {
          id: "read",
          targetId: "repository/read_file",
          eventType: "mcp.call_succeeded",
        },
      ],
    );

    expect(recovered.passed).toBe(true);
    expect(recovered.operationalFailures).toEqual(["repository/read_file"]);
    expect(recovered.unresolvedOperationalFailures).toEqual([]);
    expect(recovered.auditEventIds).toEqual(["miss", "search", "read"]);
  });

  test("does not call an empty turn verified", () => {
    expect(verifyToolExecution([], []).passed).toBe(false);
  });

  test("treats a delivered remote handoff as execution evidence", () => {
    expect(
      verifyToolExecution(
        ["bot/message_bot"],
        [
          {
            id: "handoff-delivered-1",
            targetId: "bot/message_bot",
            eventType: "agent.handoff_delivered",
          },
        ],
      ),
    ).toMatchObject({
      passed: true,
      matched: ["bot/message_bot"],
      auditEventIds: ["handoff-delivered-1"],
    });
  });

  test("treats a refused handoff as verified control behavior", () => {
    expect(
      verifyToolExecution(
        ["bot/message_bot"],
        [
          {
            id: "handoff-refused-1",
            targetId: "bot/message_bot",
            eventType: "agent.handoff_refused",
          },
        ],
      ),
    ).toMatchObject({
      passed: true,
      matched: ["bot/message_bot"],
      rejected: ["bot/message_bot"],
      operationalFailures: [],
      auditEventIds: ["handoff-refused-1"],
    });
  });

  test("converts only governed model tool names to audit refs", () => {
    expect(toolRefFromModelName("mcp__open-web__fetch_web_page")).toBe(
      "open-web/fetch_web_page",
    );
    expect(toolRefFromModelName("computer_click")).toBeNull();
    expect(toolRefFromModelName("message_bot")).toBe("bot/message_bot");
  });
});
