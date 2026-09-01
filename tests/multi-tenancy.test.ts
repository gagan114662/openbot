import { describe, expect, test } from "bun:test";
import { parse } from "yaml";

const values = parse(await Bun.file("charts/openbot/values.yaml").text()) as {
  config?: { deploymentId?: unknown };
};
const helpers = await Bun.file("charts/openbot/templates/_helpers.tpl").text();
const compose = parse(await Bun.file("docker-compose.yml").text()) as {
  services?: { supervisor?: { environment?: Record<string, unknown> } };
};
const start = await Bun.file("scripts/start.sh").text();

describe("deployment-per-tenant isolation", () => {
  test("Helm derives a stable thread namespace from namespace and release", () => {
    expect(values.config?.deploymentId).toBe("");
    expect(helpers).toContain("- name: DEPLOYMENT_ID");
    expect(helpers).toContain(
      'default (printf "%s/%s" .Release.Namespace .Release.Name)',
    );
  });

  test("local stacks derive computer identity from the Compose tenant", () => {
    expect(compose.services?.supervisor?.environment?.COMPUTER_NAMESPACE).toBe(
      "$" + "{COMPUTER_NAMESPACE:-" + "$" + "{COMPOSE_PROJECT_NAME:-openbot}}",
    );
    expect(start).toContain(
      'DEPLOYMENT_ID="$(setting DEPLOYMENT_ID "$COMPOSE_PROJECT_NAME")"',
    );
    expect(start).toContain(
      'COMPUTER_NAMESPACE="$(setting COMPUTER_NAMESPACE "$DEPLOYMENT_ID")"',
    );
  });
});
