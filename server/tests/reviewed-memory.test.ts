import { describe, expect, test } from "bun:test";
import { validateTenantPackage } from "../src/tenant-package";

const base = {
  brand: "tenant: { id: test, product_name: Test }",
  agents:
    "agents: [{ id: knowledge, name: Knowledge, title: Knowledge, role_description: Base role, type: built-in, system_prompt: Base }]",
  channels: "channels: []",
  model:
    "model: { provider: openai, credential_secret_ref: key, default_model: model }",
  knowledge: "sources: []",
  themeCss: "",
};

describe("reviewed long-term memory", () => {
  test("only a human-approved entry reaches the standing role", () => {
    const tenant = validateTenantPackage({
      ...base,
      memory: `entries:
        - { id: approved, status: approved, applies_to: [knowledge], text: Use the exception catalogue, source: policy/1, approved_by: reviewer, approved_at: 2026-09-01T12:00:00Z }
        - { id: pending, status: pending, applies_to: [knowledge], text: Never visible, source: proposal/2 }
      `,
    });
    expect(tenant.agents[0]?.roleDescription).toContain(
      "Use the exception catalogue",
    );
    expect(tenant.agents[0]?.roleDescription).not.toContain("Never visible");
    expect(tenant.reviewedMemory.map((entry) => entry.id)).toEqual([
      "approved",
    ]);
  });

  test("approved memory requires reviewer, time, source, and a registered Bot", () => {
    expect(() =>
      validateTenantPackage({
        ...base,
        memory:
          "entries: [{ id: bad, status: approved, applies_to: [missing], text: Fact, source: policy/1, approved_by: reviewer, approved_at: 2026-09-01T12:00:00Z }]",
      }),
    ).toThrow('memory entry "bad" references unknown agent "missing"');
  });
});
