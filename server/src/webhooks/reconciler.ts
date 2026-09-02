import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { reconciledWebhookEvents } from "../db/schema";

export type WebhookEnvelope = {
  provider: string;
  eventId: string;
  aggregateKey: string;
  sequence: number;
  payload: Record<string, unknown>;
};

const bounded = (value: string, name: string, maximum = 500) => {
  const result = value.trim();
  if (!result || result.length > maximum)
    throw new Error(`${name} must contain 1-${maximum} characters.`);
  return result;
};

export function retryDelayMs(attempt: number, random = Math.random) {
  const exponent = Math.min(Math.max(attempt - 1, 0), 10);
  const base = Math.min(60 * 60_000, 1_000 * 2 ** exponent);
  return Math.round(base * (0.75 + random() * 0.5));
}

export function createWebhookReconciler(
  database: Database,
  options: { tenantId: string; maximumAttempts?: number },
) {
  const maximumAttempts = options.maximumAttempts ?? 8;
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1)
    throw new Error("Webhook maximum attempts must be a positive integer.");
  return {
    async ingest(input: WebhookEnvelope) {
      if (!Number.isSafeInteger(input.sequence) || input.sequence < 1)
        throw new Error("Webhook sequence must be a positive integer.");
      await database
        .insert(reconciledWebhookEvents)
        .values({
          tenantId: options.tenantId,
          provider: bounded(input.provider, "Provider", 100),
          eventId: bounded(input.eventId, "Event id"),
          aggregateKey: bounded(input.aggregateKey, "Aggregate key"),
          sequence: input.sequence,
          payload: input.payload,
        })
        .onConflictDoNothing();
      const [event] = await database
        .select()
        .from(reconciledWebhookEvents)
        .where(
          and(
            eq(reconciledWebhookEvents.tenantId, options.tenantId),
            eq(reconciledWebhookEvents.provider, input.provider),
            eq(reconciledWebhookEvents.eventId, input.eventId),
          ),
        );
      return event;
    },

    async claim(owner: string, now = new Date(), leaseMs = 30_000) {
      const rows = await database.execute(sql`
        with candidate as (
          select event.id
          from reconciled_webhook_events event
          where event.tenant_id = ${options.tenantId}
            and event.status in ('pending', 'retrying')
            and event.available_at <= ${now}
            and (event.lease_expires_at is null or event.lease_expires_at <= ${now})
            and not exists (
              select 1 from reconciled_webhook_events earlier
              where earlier.tenant_id = event.tenant_id
                and earlier.provider = event.provider
                and earlier.aggregate_key = event.aggregate_key
                and earlier.sequence < event.sequence
                and earlier.status <> 'processed'
            )
          order by event.created_at asc
          for update skip locked
          limit 1
        )
        update reconciled_webhook_events event
        set lease_owner = ${bounded(owner, "Lease owner", 200)},
            lease_expires_at = ${new Date(now.getTime() + leaseMs)},
            attempts = event.attempts + 1,
            updated_at = now()
        from candidate
        where event.id = candidate.id
        returning event.*
      `);
      return rows[0] as typeof reconciledWebhookEvents.$inferSelect | undefined;
    },

    async complete(id: string, owner: string, now = new Date()) {
      const [event] = await database
        .update(reconciledWebhookEvents)
        .set({
          status: "processed",
          processedAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(reconciledWebhookEvents.id, id),
            eq(reconciledWebhookEvents.tenantId, options.tenantId),
            eq(reconciledWebhookEvents.leaseOwner, owner),
          ),
        )
        .returning();
      if (!event) throw new Error("Webhook lease was lost before completion.");
      return event;
    },

    async fail(
      id: string,
      owner: string,
      error: string,
      now = new Date(),
      random = Math.random,
    ) {
      const [event] = await database
        .select()
        .from(reconciledWebhookEvents)
        .where(
          and(
            eq(reconciledWebhookEvents.id, id),
            eq(reconciledWebhookEvents.tenantId, options.tenantId),
            eq(reconciledWebhookEvents.leaseOwner, owner),
          ),
        );
      if (!event)
        throw new Error("Webhook lease was lost before failure handling.");
      const dead = event.attempts >= maximumAttempts;
      const [updated] = await database
        .update(reconciledWebhookEvents)
        .set({
          status: dead ? "dead" : "retrying",
          availableAt: dead
            ? now
            : new Date(now.getTime() + retryDelayMs(event.attempts, random)),
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: bounded(error, "Webhook error", 2_000),
          updatedAt: now,
        })
        .where(eq(reconciledWebhookEvents.id, id))
        .returning();
      return updated;
    },

    async dashboard() {
      const events = await database
        .select()
        .from(reconciledWebhookEvents)
        .where(eq(reconciledWebhookEvents.tenantId, options.tenantId))
        .orderBy(desc(reconciledWebhookEvents.createdAt))
        .limit(200);
      return {
        events,
        pending: events.filter((event) =>
          ["pending", "retrying"].includes(event.status),
        ).length,
        dead: events.filter((event) => event.status === "dead").length,
        processed: events.filter((event) => event.status === "processed")
          .length,
      };
    },

    async replayDead(id: string, now = new Date()) {
      const [event] = await database
        .update(reconciledWebhookEvents)
        .set({
          status: "pending",
          attempts: 0,
          availableAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(reconciledWebhookEvents.id, id),
            eq(reconciledWebhookEvents.tenantId, options.tenantId),
            eq(reconciledWebhookEvents.status, "dead"),
          ),
        )
        .returning();
      if (!event) throw new Error("Dead-letter webhook was not found.");
      return event;
    },
  };
}

export type WebhookReconciler = ReturnType<typeof createWebhookReconciler>;
