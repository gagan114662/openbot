import { createHmac, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import type { VerifiedValueStore } from "../software-factory/verified-value";
import type { WebhookReconciler } from "../webhooks/reconciler";
import type { ProductionEngineerStore } from "./store";

const text = (value: unknown, maximum = 2_000) =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, maximum)
    : null;

export function createProductionEngineerRoutes(
  store: ProductionEngineerStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  options: {
    githubWebhookSecret?: string;
    alertmanagerWebhookSecret?: string;
    githubToken?: string;
    fetch?: typeof fetch;
    reconciler?: WebhookReconciler;
    valueWebhookSecret?: string;
  } = {
    githubWebhookSecret: process.env.PRODUCTION_ENGINEER_GITHUB_WEBHOOK_SECRET,
    alertmanagerWebhookSecret:
      process.env.PRODUCTION_ENGINEER_ALERTMANAGER_WEBHOOK_SECRET,
    githubToken: process.env.GITHUB_TOKEN,
  },
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.post("/value-webhook", async (context) => {
    if (!options.valueWebhookSecret || !options.reconciler)
      return context.notFound();
    const raw = await context.req.text();
    const offered = context.req.header("x-openbot-signature-256") ?? "";
    const expected = `sha256=${createHmac("sha256", options.valueWebhookSecret).update(raw).digest("hex")}`;
    const offeredBytes = Buffer.from(offered);
    const expectedBytes = Buffer.from(expected);
    if (
      offeredBytes.length !== expectedBytes.length ||
      !timingSafeEqual(offeredBytes, expectedBytes)
    )
      return context.json({ error: "Webhook signature is invalid." }, 401);
    const body = JSON.parse(raw) as Record<string, unknown>;
    const eventId = text(body.eventId, 500);
    const workflowRunId = text(body.workflowRunId, 500);
    const source = text(body.source, 200);
    if (!eventId || !workflowRunId || !source)
      return context.json(
        { error: "Event, workflow, and source are required." },
        400,
      );
    const event = await options.reconciler.ingest({
      provider: `verified-value:${source}`,
      eventId,
      aggregateKey: workflowRunId,
      sequence: 1,
      payload: {
        kind: "verified-value",
        actorId: `value-source:${source}`,
        input: { ...body, sourceEventId: eventId },
      },
    });
    return context.json({ accepted: true, event }, 202);
  });
  routes.get("/metrics", async (context) =>
    context.text(await store.prometheusMetrics(), 200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
    }),
  );
  routes.post("/alertmanager-webhook", async (context) => {
    if (!options.alertmanagerWebhookSecret) return context.notFound();
    const raw = await context.req.text();
    const offered = context.req.header("x-openbot-signature-256") ?? "";
    const expected = `sha256=${createHmac(
      "sha256",
      options.alertmanagerWebhookSecret,
    )
      .update(raw)
      .digest("hex")}`;
    const offeredBytes = Buffer.from(offered);
    const expectedBytes = Buffer.from(expected);
    if (
      offeredBytes.length !== expectedBytes.length ||
      !timingSafeEqual(offeredBytes, expectedBytes)
    )
      return context.json({ error: "Webhook signature is invalid." }, 401);
    const payload = JSON.parse(raw) as {
      alerts?: Array<{
        status?: unknown;
        labels?: Record<string, unknown>;
        annotations?: Record<string, unknown>;
        startsAt?: unknown;
      }>;
    };
    const results = [];
    for (const [index, alert] of (payload.alerts ?? [])
      .slice(0, 100)
      .entries()) {
      if (alert.status !== "firing") continue;
      const monitorKey = text(alert.labels?.monitor_key, 200);
      const value = Number(alert.annotations?.openbot_value);
      if (!monitorKey || !Number.isFinite(value)) continue;
      const input = {
        monitorKey,
        value,
        labels: Object.fromEntries(
          Object.entries(alert.labels ?? {})
            .slice(0, 50)
            .flatMap(([key, item]) =>
              typeof item === "string" ? [[key, item]] : [],
            ),
        ),
        ...(text(alert.startsAt, 100)
          ? { firedAt: text(alert.startsAt, 100) as string }
          : {}),
      };
      if (options.reconciler) {
        results.push(
          await options.reconciler.ingest({
            provider: "alertmanager",
            eventId: createHmac("sha256", options.alertmanagerWebhookSecret)
              .update(`${raw}:${index}`)
              .digest("hex"),
            aggregateKey: `${monitorKey}:${text(alert.startsAt, 100) ?? "firing"}:${index}`,
            sequence: 1,
            payload: {
              kind: "alertmanager-firing",
              actorId: "alertmanager:webhook",
              input,
            },
          }),
        );
      } else {
        results.push(await store.triageAlert("alertmanager:webhook", input));
      }
    }
    return context.json({ accepted: results.length, results }, 202);
  });
  routes.post("/github-webhook", async (context) => {
    if (!options.githubWebhookSecret) return context.notFound();
    const raw = await context.req.text();
    const offered = context.req.header("x-hub-signature-256") ?? "";
    const expected = `sha256=${createHmac("sha256", options.githubWebhookSecret)
      .update(raw)
      .digest("hex")}`;
    const offeredBytes = Buffer.from(offered);
    const expectedBytes = Buffer.from(expected);
    if (
      offeredBytes.length !== expectedBytes.length ||
      !timingSafeEqual(offeredBytes, expectedBytes)
    ) {
      return context.json({ error: "Webhook signature is invalid." }, 401);
    }
    const eventName = context.req.header("x-github-event");
    if (eventName === "workflow_run") {
      const payload = JSON.parse(raw) as {
        action?: unknown;
        repository?: { full_name?: unknown };
        workflow_run?: {
          conclusion?: unknown;
          pull_requests?: Array<{ number?: unknown }>;
        };
      };
      const repository = text(payload.repository?.full_name, 200);
      const conclusion = text(payload.workflow_run?.conclusion, 100);
      const failedConclusions = new Set([
        "failure",
        "timed_out",
        "cancelled",
        "startup_failure",
      ]);
      if (
        payload.action !== "completed" ||
        !repository ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
        !conclusion ||
        !failedConclusions.has(conclusion)
      ) {
        return context.json({ ignored: true }, 202);
      }
      const pullRequests = (payload.workflow_run?.pull_requests ?? [])
        .map((pullRequest) => pullRequest.number)
        .filter((number): number is number => Number.isSafeInteger(number));
      const updated = (
        await Promise.all(
          pullRequests.map((number) =>
            store.failFixFromCi(
              `https://github.com/${repository}/pull/${number}`,
            ),
          ),
        )
      ).flat();
      return context.json(
        { accepted: true, conclusion, failedFixes: updated.length },
        202,
      );
    }
    if (eventName !== "pull_request") {
      return context.json({ ignored: true }, 202);
    }
    const payload = JSON.parse(raw) as {
      action?: unknown;
      repository?: { full_name?: unknown };
      sender?: { login?: unknown };
      pull_request?: {
        number?: unknown;
        html_url?: unknown;
        title?: unknown;
        body?: unknown;
        merged?: unknown;
        changed_files?: unknown;
        merged_at?: unknown;
      };
    };
    const repository = text(payload.repository?.full_name, 200);
    const pullRequest = payload.pull_request;
    if (
      payload.action !== "closed" ||
      pullRequest?.merged !== true ||
      !repository ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      !Number.isSafeInteger(pullRequest.number)
    ) {
      return context.json({ ignored: true }, 202);
    }
    const [owner, name] = repository.split("/");
    const pageCount = Math.min(
      10,
      Math.max(1, Math.ceil(Number(pullRequest.changed_files ?? 1) / 100)),
    );
    const request = options.fetch ?? fetch;
    const changedPaths: string[] = [];
    for (let page = 1; page <= pageCount; page += 1) {
      const response = await request(
        `https://api.github.com/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}/pulls/${pullRequest.number}/files?per_page=100&page=${page}`,
        {
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "openbot-production-engineer",
            ...(options.githubToken
              ? { authorization: `Bearer ${options.githubToken}` }
              : {}),
          },
        },
      );
      if (!response.ok) {
        return context.json(
          { error: "GitHub pull-request files could not be loaded." },
          502,
        );
      }
      const files = (await response.json()) as Array<{ filename?: unknown }>;
      changedPaths.push(
        ...files
          .map((file) => text(file.filename, 1_000))
          .filter((file): file is string => Boolean(file)),
      );
    }
    if (changedPaths.length === 0) {
      return context.json({ error: "Merged pull request had no files." }, 400);
    }
    const intent = [text(pullRequest.title, 500), text(pullRequest.body, 1_500)]
      .filter(Boolean)
      .join("\n");
    const actorId = `github:${text(payload.sender?.login, 100) ?? "webhook"}`;
    const input = {
      pullRequest:
        text(pullRequest.html_url, 500) ??
        `${repository}#${pullRequest.number}`,
      intent: intent || "Merged pull request",
      changedPaths,
      ...(text(pullRequest.merged_at, 100)
        ? { deployedAt: text(pullRequest.merged_at, 100) as string }
        : {}),
    };
    if (options.reconciler) {
      const delivery = text(context.req.header("x-github-delivery"), 500);
      if (!delivery)
        return context.json({ error: "GitHub delivery id is required." }, 400);
      const event = await options.reconciler.ingest({
        provider: "github",
        eventId: delivery,
        aggregateKey: `${repository}#${pullRequest.number}`,
        sequence: 1,
        payload: { kind: "github-merge", actorId, input },
      });
      return context.json({ accepted: true, event }, 202);
    }
    return context.json(await store.monitorsFromMerge(actorId, input), 201);
  });
  routes.use("*", requireUser, async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await next();
  });
  routes.get("/", async (context) => context.json(await store.dashboard()));
  routes.get("/prometheus-rules", async (context) =>
    context.text(await store.prometheusRules(), 200, {
      "content-type": "application/yaml; charset=utf-8",
      "content-disposition":
        'attachment; filename="openbot-generated-alerts.yml"',
    }),
  );
  routes.post("/merges", async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      pullRequest?: unknown;
      intent?: unknown;
      changedPaths?: unknown;
      deployedAt?: unknown;
    } | null;
    const pullRequest = text(body?.pullRequest, 500);
    const intent = text(body?.intent);
    const changedPaths = Array.isArray(body?.changedPaths)
      ? body.changedPaths
          .filter((item): item is string => typeof item === "string")
          .slice(0, 1_000)
      : [];
    if (!pullRequest || !intent || changedPaths.length === 0) {
      return context.json(
        { error: "Pull request, intent, and changed paths are required." },
        400,
      );
    }
    return context.json(
      await store.monitorsFromMerge(context.var.actor.id, {
        pullRequest,
        intent,
        changedPaths,
        ...(text(body?.deployedAt, 100)
          ? { deployedAt: text(body?.deployedAt, 100) as string }
          : {}),
      }),
      201,
    );
  });
  routes.post("/alerts", async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      monitorKey?: unknown;
      value?: unknown;
      labels?: unknown;
    } | null;
    const monitorKey = text(body?.monitorKey, 200);
    if (
      !monitorKey ||
      typeof body?.value !== "number" ||
      !Number.isFinite(body.value)
    ) {
      return context.json(
        { error: "Monitor key and finite value are required." },
        400,
      );
    }
    return context.json(
      await store.triageAlert(context.var.actor.id, {
        monitorKey,
        value: body.value,
        ...(body.labels &&
        typeof body.labels === "object" &&
        !Array.isArray(body.labels)
          ? { labels: body.labels as Record<string, string> }
          : {}),
      }),
      202,
    );
  });
  routes.post("/monitors/:monitorId/tune", async (context) =>
    context.json({
      proposal: await store.proposeTuning(context.req.param("monitorId")),
    }),
  );
  routes.post("/monitors/:monitorId/tune/apply", async (context) =>
    context.json({
      applied: await store.applyTuning(
        context.var.actor.id,
        context.req.param("monitorId"),
      ),
    }),
  );
  routes.post("/monitors/:monitorId/tune/reject", async (context) =>
    context.json({
      rejected: await store.rejectTuning(
        context.var.actor.id,
        context.req.param("monitorId"),
      ),
    }),
  );
  routes.post("/issues/:issueId/fix", async (context) => {
    const issueId = context.req.param("issueId");
    const actorId = context.var.actor.id;
    // A real Codex fix takes minutes. Holding the request open lets Bun's HTTP idle timeout turn a
    // healthy child into a browser-visible failure while the child keeps working. The durable issue
    // row is the job state; the admin page polls it until the terminal status lands.
    const issue = await store.claimFix(actorId, issueId).catch(() => null);
    if (!issue)
      return context.json(
        {
          error: "A fix is already running or awaiting review for this issue.",
        },
        409,
      );
    void store.runClaimedFix(actorId, issue).catch((error) => {
      console.error(
        JSON.stringify({
          type: "production-fix-failed",
          issueId,
          error: error instanceof Error ? error.message : "Unknown failure",
        }),
      );
    });
    return context.json({ fix: { issueId, status: "accepted" } }, 202);
  });
  routes.patch("/issues/:issueId/status", async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      status?: unknown;
    } | null;
    const status = text(body?.status, 30);
    if (!status)
      return context.json({ error: "Issue status is required." }, 400);
    return context.json({
      issue: await store.setIssueStatus(
        context.var.actor.id,
        context.req.param("issueId"),
        status,
      ),
    });
  });
  routes.post("/issues/:issueId/investigations", async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      summary?: unknown;
      outcome?: unknown;
      approved?: unknown;
    } | null;
    const summary = text(body?.summary, 10_000);
    const outcome = text(body?.outcome, 10_000);
    if (!summary || !outcome)
      return context.json({ error: "Summary and outcome are required." }, 400);
    return context.json(
      {
        investigation: await store.recordInvestigation(
          context.var.actor.id,
          context.req.param("issueId"),
          { summary, outcome, approved: body?.approved === true },
        ),
      },
      201,
    );
  });
  return routes;
}

export async function processProductionWebhook(
  store: ProductionEngineerStore,
  event: { payload: unknown },
  verifiedValues?: VerifiedValueStore,
) {
  const payload = event.payload as {
    kind?: unknown;
    actorId?: unknown;
    input?: unknown;
  };
  if (
    typeof payload.actorId !== "string" ||
    !payload.input ||
    typeof payload.input !== "object"
  )
    throw new Error("Reconciled production webhook payload is malformed.");
  if (payload.kind === "alertmanager-firing")
    return store.triageAlert(
      payload.actorId,
      payload.input as Parameters<ProductionEngineerStore["triageAlert"]>[1],
    );
  if (payload.kind === "github-merge")
    return store.monitorsFromMerge(
      payload.actorId,
      payload.input as Parameters<
        ProductionEngineerStore["monitorsFromMerge"]
      >[1],
    );
  if (payload.kind === "verified-value") {
    if (!verifiedValues)
      throw new Error("Verified value processor is not configured.");
    return verifiedValues.record(
      payload.input as Parameters<VerifiedValueStore["record"]>[0],
    );
  }
  throw new Error("Reconciled production webhook kind is unsupported.");
}
