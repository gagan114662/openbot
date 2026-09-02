import { describe, expect, test } from "bun:test";
import {
  contentForPrivacyMode,
  redactAnalyticsProperties,
  redactAnalyticsText,
} from "../src/analytics/privacy";

describe("agent analytics privacy", () => {
  test("redacts common PII and credential-shaped values before persistence", () => {
    const value = redactAnalyticsText(
      "Email alex@example.com, call +1 (416) 555-0199, card 4242 4242 4242 4242, SSN 123-45-6789, IP 192.168.1.7, key sk-test_abcdefghijklmnop",
    );
    expect(value).not.toContain("alex@example.com");
    expect(value).not.toContain("4242 4242 4242 4242");
    expect(value).not.toContain("123-45-6789");
    expect(value).not.toContain("192.168.1.7");
    expect(value).not.toContain("sk-test_abcdefghijklmnop");
    expect(value).toContain("[EMAIL_REDACTED]");
  });

  test("redacts cloud keys, JWTs and internationalised email domains", () => {
    const value = redactAnalyticsText(
      "AKIAIOSFODNN7EXAMPLE AIzaSyA12345678901234567890123456789012 eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2lnbmF0dXJl user@xn--bcher-kva.example",
    );
    expect(value).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(value).not.toContain("AIzaSyA");
    expect(value).not.toContain("eyJhbGci");
    expect(value).not.toContain("user@xn--bcher-kva.example");
    expect(value).toContain("[AWS_KEY_REDACTED]");
    expect(value).toContain("[GOOGLE_KEY_REDACTED]");
    expect(value).toContain("[JWT_REDACTED]");
    expect(value).toContain("[EMAIL_REDACTED]");
  });

  test("metadata-only and customer-enriched sources cannot store raw conversation", () => {
    expect(contentForPrivacyMode("private prompt", "metadata_only")).toBeNull();
    expect(
      contentForPrivacyMode("private prompt", "customer_enriched"),
    ).toBeNull();
    expect(contentForPrivacyMode("safe reply to me@example.com", "full")).toBe(
      "safe reply to [EMAIL_REDACTED]",
    );
  });

  test("redacts sensitive property keys recursively", () => {
    expect(
      redactAnalyticsProperties({
        model: "gpt-5",
        authorization: "Bearer secret",
        nested: { apiKey: "secret", email: "me@example.com" },
      }),
    ).toEqual({
      model: "gpt-5",
      authorization: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", email: "[EMAIL_REDACTED]" },
    });
  });

  test("does not corrupt UUID correlation keys while redacting phone numbers", () => {
    const threadId = "journey-ccf97633-8f87-486b-9705-1512156cf56e";
    expect(redactAnalyticsText(threadId)).toBe(threadId);
    expect(redactAnalyticsText("call +1 (416) 555-0199")).toBe(
      "call [PHONE_REDACTED]",
    );
  });
});
