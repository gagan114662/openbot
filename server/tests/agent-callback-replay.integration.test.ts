import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mintRunAssertion } from "../src/agents/callback-token";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { agentToolAssertionUses } from "../src/db/schema";
import { TEST_POOL } from "./support/database";
import { testEnvironment } from "./support/environment";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const config = loadConfig(
  testEnvironment({ AGENT_TOOL_TOKEN: "callback-secret" }),
);
let assertionId = "";

afterAll(async () => {
  if (assertionId) {
    await database
      .delete(agentToolAssertionUses)
      .where(eq(agentToolAssertionUses.assertionId, assertionId));
  }
});

function replica() {
  const args: Parameters<typeof createApp> = [config];
  // The callback route is deliberately absent when no governed plugin store exists.
  args[14] = { callTool: async () => ({ text: "plugin tool ran" }) } as never;
  args[25] = async () => ({ text: "tool ran" });
  args[26] = async (id, expiresAt) => {
    assertionId = id;
    const rows = await database
      .insert(agentToolAssertionUses)
      .values({ assertionId: id, expiresAt: new Date(expiresAt) })
      .onConflictDoNothing()
      .returning({ assertionId: agentToolAssertionUses.assertionId });
    return rows.length === 1;
  };
  return createApp(...args);
}

describe("single-use agent tool assertions", () => {
  test("a second replica refuses replay of the same signed request", async () => {
    const ticket = mintRunAssertion(
      {
        botId: "general-assistant",
        actorId: "person-7",
        runId: "replay-proof",
      },
      config.keyEncryptionKey,
      Date.now(),
      "tool-call",
    );
    const request = () =>
      new Request("http://openbot.test/api/agent-tools/call", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openbot-agent-token": "callback-secret",
        },
        body: JSON.stringify({ name: "message_bot", args: {}, run: ticket }),
      });

    const first = await replica().fetch(request());
    const replay = await replica().fetch(request());
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ text: "tool ran" });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: "Not authorised." });

    const uses = await database
      .select()
      .from(agentToolAssertionUses)
      .where(eq(agentToolAssertionUses.assertionId, assertionId));
    expect(uses).toHaveLength(1);
  });
});
