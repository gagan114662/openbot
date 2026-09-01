import { describe, expect, test } from "bun:test";
import { mintRunAssertion } from "../src/agents/callback-token";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

describe("remote agent reach-tool callbacks", () => {
  test("executes a deployment-owned tool from authenticated run identity", async () => {
    const config = loadConfig(
      testEnvironment({ AGENT_TOOL_TOKEN: "callback-secret" }),
    );
    let pluginCalls = 0;
    const pluginStore = {
      callTool: async () => {
        pluginCalls += 1;
        return { text: "wrong path", isError: false };
      },
    };
    const seen: unknown[] = [];
    const args: Parameters<typeof createApp> = [config];
    args[14] = pluginStore as never;
    args[25] = async (input) => {
      seen.push(input);
      return input.name === "message_bot" ? { text: "handoff queued" } : null;
    };
    const app = createApp(...args);
    const run = mintRunAssertion(
      {
        botId: "general-assistant",
        actorId: "person-7",
        runId: "run-9",
        threadId: "thread-3",
        depth: 2,
      },
      config.keyEncryptionKey,
    );

    const response = await app.request(
      "http://openbot.test/api/agent-tools/call",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openbot-agent-token": "callback-secret",
        },
        body: JSON.stringify({
          name: "message_bot",
          args: { bot: "knowledge", task: "Find the rule" },
          run,
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "handoff queued" });
    expect(pluginCalls).toBe(0);
    expect(seen).toEqual([
      {
        name: "message_bot",
        args: { bot: "knowledge", task: "Find the rule" },
        run: {
          botId: "general-assistant",
          actorId: "person-7",
          runId: "run-9",
          threadId: "thread-3",
          depth: 2,
        },
      },
    ]);
  });

  test("keeps ordinary plugin calls on the governed plugin path", async () => {
    const config = loadConfig(
      testEnvironment({ AGENT_TOOL_TOKEN: "callback-secret" }),
    );
    const called: unknown[] = [];
    const args: Parameters<typeof createApp> = [config];
    args[14] = {
      callTool: async (input: unknown) => {
        called.push(input);
        return { text: "plugin result", isError: false };
      },
    } as never;
    args[25] = async () => null;
    const app = createApp(...args);
    const run = mintRunAssertion(
      { botId: "knowledge", actorId: "person-7", runId: "run-10" },
      config.keyEncryptionKey,
    );

    const response = await app.request(
      "http://openbot.test/api/agent-tools/call",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openbot-agent-token": "callback-secret",
        },
        body: JSON.stringify({
          name: "mcp__repository__read_repository_file",
          args: { path: "README.md" },
          run,
        }),
      },
    );

    expect(await response.json()).toEqual({
      text: "plugin result",
      isError: false,
    });
    expect(called).toHaveLength(1);
  });
});
