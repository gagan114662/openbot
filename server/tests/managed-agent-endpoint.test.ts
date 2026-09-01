import { describe, expect, test } from "bun:test";
import { isManagedAgentEndpoint } from "../src/agents/runtime-agents";

describe("managed agent endpoint identity", () => {
  const managed = new URL("http://localhost:4202/ag-ui");

  test("allows profiles on the one configured adapter", () => {
    expect(
      isManagedAgentEndpoint(
        "http://localhost:4202/ag-ui?profile=knowledge",
        managed,
      ),
    ).toBe(true);
  });

  test.each([
    "http://localhost:4203/ag-ui?profile=knowledge",
    "http://localhost:4202/other?profile=knowledge",
    "https://localhost:4202/ag-ui?profile=knowledge",
    "not a URL",
  ])(
    "does not send the token outside its exact service boundary",
    (endpoint) => {
      expect(isManagedAgentEndpoint(endpoint, managed)).toBe(false);
    },
  );
});
