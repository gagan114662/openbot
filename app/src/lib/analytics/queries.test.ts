import { describe, expect, test } from "bun:test";
import { type AnalyticsSession, analyticsSessionLabel } from "./queries";

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
