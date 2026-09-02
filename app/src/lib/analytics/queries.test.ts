import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  type AnalyticsSession,
  analyticsSessionLabel,
  fetchAnalyticsSessions,
  revenueMicrosFromDollars,
} from "./queries";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("business outcome revenue", () => {
  test("converts decimal dollars to exact integer micros", () => {
    expect(revenueMicrosFromDollars("12.50")).toBe(12_500_000);
    expect(revenueMicrosFromDollars("0.000001")).toBe(1);
  });

  test("refuses negative, over-precise, or non-numeric revenue", () => {
    expect(revenueMicrosFromDollars("-1")).toBeNull();
    expect(revenueMicrosFromDollars("1.0000001")).toBeNull();
    expect(revenueMicrosFromDollars("twelve")).toBeNull();
  });
});

const session = {
  id: "channel:opaque-id",
  source: "openbot-channel",
  intent: null,
  summary: null,
} as AnalyticsSession;

describe("analytics session labels", () => {
  test("does not present an opaque trace id as a channel turn's intent", () => {
    expect(analyticsSessionLabel(session)).toBe("Channel turn");
  });

  test("prefers an available intent", () => {
    expect(
      analyticsSessionLabel({ ...session, intent: "Reconcile revenue" }),
    ).toBe("Reconcile revenue");
  });

  test("keeps the id for sources without a semantic fallback", () => {
    expect(analyticsSessionLabel({ ...session, source: "external" })).toBe(
      "channel:opaque-id",
    );
  });
});

test("the session explorer requests one bounded page", async () => {
  let requested = "";
  globalThis.fetch = mock(async (input) => {
    requested = String(input);
    return Response.json({ sessions: [] });
  }) as unknown as typeof fetch;

  await fetchAnalyticsSessions("failed handoff", 2, 25);

  expect(requested).toBe(
    "/api/analytics/admin/sessions?limit=25&offset=50&search=failed+handoff",
  );
});
