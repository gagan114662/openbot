import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createProductionEngineerRoutes } from "../src/production-engineer/routes";
import type { ProductionEngineerStore } from "../src/production-engineer/store";

const secret = "webhook-proof-secret";
const payload = JSON.stringify({
  action: "closed",
  repository: { full_name: "gagan114662/openbot" },
  sender: { login: "merge-bot" },
  pull_request: {
    number: 42,
    html_url: "https://github.com/gagan114662/openbot/pull/42",
    title: "Harden analytics ingestion",
    body: "Keep business outcomes trustworthy.",
    merged: true,
    changed_files: 2,
    merged_at: "2026-09-01T12:00:00Z",
  },
});

function signature(body: string) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("Production Engineer GitHub ingress", () => {
  test("rejects an unsigned delivery before reading repository data", async () => {
    let fetched = false;
    const routes = createProductionEngineerRoutes(
      {} as ProductionEngineerStore,
      async (_context, next) => next(),
      {
        githubWebhookSecret: secret,
        fetch: async () => {
          fetched = true;
          return Response.json([]);
        },
      },
    );
    const response = await routes.request("/github-webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
      },
      body: payload,
    });
    expect(response.status).toBe(401);
    expect(fetched).toBe(false);
  });

  test("turns a signed merged pull request into monitors from its real files", async () => {
    const observed: unknown[] = [];
    const routes = createProductionEngineerRoutes(
      {
        async monitorsFromMerge(actorId, input) {
          observed.push({ actorId, input });
          return { createdOrUpdated: 1, monitors: [] };
        },
      } as ProductionEngineerStore,
      async (_context, next) => next(),
      {
        githubWebhookSecret: secret,
        fetch: async () =>
          Response.json([
            { filename: "server/src/analytics/store.ts" },
            { filename: "app/src/routes/_authed/admin/analytics.tsx" },
          ]),
      },
    );
    const response = await routes.request("/github-webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signature(payload),
      },
      body: payload,
    });
    expect(response.status).toBe(201);
    expect(observed).toEqual([
      {
        actorId: "github:merge-bot",
        input: {
          pullRequest: "https://github.com/gagan114662/openbot/pull/42",
          intent:
            "Harden analytics ingestion\nKeep business outcomes trustworthy.",
          changedPaths: [
            "server/src/analytics/store.ts",
            "app/src/routes/_authed/admin/analytics.tsx",
          ],
          deployedAt: "2026-09-01T12:00:00Z",
        },
      },
    ]);
  });

  test("marks the matching autonomous fix failed from a signed red workflow", async () => {
    const failedPullRequests: string[] = [];
    const routes = createProductionEngineerRoutes(
      {
        async failFixFromCi(pullRequestUrl) {
          failedPullRequests.push(pullRequestUrl);
          return [{ id: "issue-1" }];
        },
      } as ProductionEngineerStore,
      async (_context, next) => next(),
      { githubWebhookSecret: secret },
    );
    const workflowPayload = JSON.stringify({
      action: "completed",
      repository: { full_name: "gagan114662/openbot" },
      workflow_run: {
        conclusion: "failure",
        pull_requests: [{ number: 25 }],
      },
    });
    const response = await routes.request("/github-webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "workflow_run",
        "x-hub-signature-256": signature(workflowPayload),
      },
      body: workflowPayload,
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      accepted: true,
      conclusion: "failure",
      failedFixes: 1,
    });
    expect(failedPullRequests).toEqual([
      "https://github.com/gagan114662/openbot/pull/25",
    ]);
  });
});

describe("Production Engineer Alertmanager ingress", () => {
  const alertPayload = JSON.stringify({
    alerts: [
      {
        status: "firing",
        labels: {
          monitor_key: "tool-call-failures",
          deployment: "tenant-a",
        },
        annotations: { openbot_value: "7" },
        startsAt: "2026-09-02T12:00:00Z",
      },
    ],
  });

  test("rejects a forged alert before triage", async () => {
    let called = false;
    const routes = createProductionEngineerRoutes(
      {
        async triageAlert() {
          called = true;
          return { genuine: false, rootCause: "" };
        },
      } as ProductionEngineerStore,
      async (_context, next) => next(),
      { alertmanagerWebhookSecret: secret },
    );
    const response = await routes.request("/alertmanager-webhook", {
      method: "POST",
      headers: { "x-openbot-signature-256": "sha256=forged" },
      body: alertPayload,
    });
    expect(response.status).toBe(401);
    expect(called).toBe(false);
  });

  test("triages a signed firing with its measured value and labels", async () => {
    const observed: unknown[] = [];
    const routes = createProductionEngineerRoutes(
      {
        async triageAlert(actorId, input) {
          observed.push({ actorId, input });
          return { genuine: true, rootCause: "measured", issue: {} };
        },
      } as ProductionEngineerStore,
      async (_context, next) => next(),
      { alertmanagerWebhookSecret: secret },
    );
    const response = await routes.request("/alertmanager-webhook", {
      method: "POST",
      headers: { "x-openbot-signature-256": signature(alertPayload) },
      body: alertPayload,
    });
    expect(response.status).toBe(202);
    expect(observed).toEqual([
      {
        actorId: "alertmanager:webhook",
        input: {
          monitorKey: "tool-call-failures",
          value: 7,
          labels: {
            monitor_key: "tool-call-failures",
            deployment: "tenant-a",
          },
          firedAt: "2026-09-02T12:00:00Z",
        },
      },
    ]);
  });
});
