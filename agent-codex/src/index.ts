import { mkdirSync } from "node:fs";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { serve, spawn } from "bun";
import { hasManagedAgentToken } from "../../shared/agent-authorisation";
import {
  contentRefusal,
  inspectToolArguments,
} from "../../shared/content-guard";
import { AdapterOperations, type RunPermit } from "./operations";
import {
  assessTechnicalDebt,
  changedPaths,
  debtBudgetFromEnvironment,
} from "./debt";
import {
  type CodexRunAnalytics,
  modelFromThreadStart,
  usageFromNotification,
} from "./run-analytics";
import {
  asError,
  childExitError,
  parseAppServerLine,
  positiveInteger,
  RequestWaiters,
  RunPermitLease,
  spawnWithPermit,
} from "./runtime-guards";
import { toolCallResultEvent } from "./tool-events";
import { codexToolNames } from "./tool-names";

const PORT = Number.parseInt(process.env.CODEX_AGENT_PORT ?? "4202", 10);
const MODEL = process.env.CODEX_MODEL?.trim() || undefined;
const ALLOW_SECRET_TOOL_ARGS =
  process.env.CODEX_ALLOW_SECRET_TOOL_ARGS?.trim().toLowerCase() === "true";
const MANAGED_AGENT_TOKEN = process.env.MANAGED_AGENT_TOKEN?.trim();
const TOOL_URL =
  process.env.OPENBOT_TOOL_URL ?? "http://localhost:3001/api/agent-tools/call";
const TOOL_TOKEN = process.env.AGENT_TOOL_TOKEN ?? "";
const MAX_TOOL_CALLS = positiveInteger(process.env.CODEX_MAX_TOOL_CALLS, 20);
const TURN_TIMEOUT_MS = positiveInteger(
  process.env.CODEX_TURN_TIMEOUT_MS,
  120_000,
);
const REQUEST_TIMEOUT_MS = positiveInteger(
  process.env.CODEX_REQUEST_TIMEOUT_MS,
  30_000,
);
const CALLBACK_TIMEOUT_MS = positiveInteger(
  process.env.CODEX_CALLBACK_TIMEOUT_MS,
  30_000,
);
const DAILY_RUN_BUDGET = positiveInteger(
  process.env.CODEX_DAILY_RUN_BUDGET,
  500,
);
const MAX_CONCURRENT_RUNS = positiveInteger(
  process.env.CODEX_MAX_CONCURRENT_RUNS,
  4,
);
const DEBT_BUDGET = debtBudgetFromEnvironment(process.env);
const operations = new AdapterOperations(
  DAILY_RUN_BUDGET,
  MAX_CONCURRENT_RUNS,
  process.env.CODEX_USAGE_STATE_FILE ?? ".codex-adapter-usage.json",
  process.env.DEPLOYMENT_ID ?? "local",
);
await operations.load();
const CODEX_WORKSPACE =
  process.env.CODEX_ADAPTER_WORKSPACE ?? "/tmp/openbot-codex-adapter";
mkdirSync(CODEX_WORKSPACE, { recursive: true, mode: 0o700 });
const NATIVE_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex";
const CODE_MODE_HOST =
  "/Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host";
const USE_MACOS_SANDBOX =
  process.platform === "darwin" &&
  process.env.CODEX_OS_SANDBOX !== "off" &&
  (await Bun.file(NATIVE_CODEX).exists());

function appServerCommand(): string[] {
  if (!USE_MACOS_SANDBOX) return ["codex", "app-server", "--stdio"];
  const profile = [
    "(version 1)",
    "(allow default)",
    "(deny process-exec)",
    `(allow process-exec (literal "${NATIVE_CODEX}"))`,
    `(allow process-exec (literal "${CODE_MODE_HOST}"))`,
  ].join(" ");
  return [
    "/usr/bin/sandbox-exec",
    "-p",
    profile,
    NATIVE_CODEX,
    "app-server",
    "--stdio",
    "-c",
    "shell_environment_policy.inherit=none",
  ];
}

function spawnAppServer() {
  return spawn(appServerCommand(), {
    cwd: CODEX_WORKSPACE,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

if (!MANAGED_AGENT_TOKEN) {
  console.error("MANAGED_AGENT_TOKEN is required.");
  process.exit(1);
}

type Json = Record<string, unknown>;

function toolRunAssertionsOf(input: RunAgentInput): () => string {
  const props = input.forwardedProps as
    | { openbotToolRuns?: unknown }
    | undefined;
  const assertions = Array.isArray(props?.openbotToolRuns)
    ? props.openbotToolRuns.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  let index = 0;
  return () => assertions[index++] ?? "";
}

function deploymentToolsOf(input: RunAgentInput): Set<string> {
  const props = input.forwardedProps as
    | { openbotDeploymentTools?: unknown }
    | undefined;
  const names = props?.openbotDeploymentTools;
  return new Set(
    Array.isArray(names)
      ? names.filter((n): n is string => typeof n === "string")
      : [],
  );
}

async function callTool(
  run: string,
  name: string,
  args: Json,
): Promise<string> {
  if (!TOOL_TOKEN)
    return "Refused. This Bot has no deployment tool credential.";
  if (!run) return "Refused. This run has no signed OpenBot assertion.";
  try {
    const response = await fetch(TOOL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbot-agent-token": TOOL_TOKEN,
      },
      body: JSON.stringify({ name, args, run }),
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    });
    const body = (await response.json()) as { text?: string };
    return body.text ?? "The tool returned nothing.";
  } catch (error) {
    return `That tool could not be called: ${error instanceof Error ? error.message : "unknown error"}`;
  }
}

function promptOf(input: RunAgentInput): string {
  return (input.messages ?? [])
    .map((message) => {
      const role =
        typeof message.role === "string"
          ? message.role.toUpperCase()
          : "MESSAGE";
      const content =
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content);
      return `${role}: ${content}`;
    })
    .join("\n\n");
}

const PROFILE_INSTRUCTIONS: Record<string, string> = {
  "general-assistant":
    "Help with everyday work using clear, concise, and accurate answers.",
  knowledge:
    "Answer only from sources returned by granted tools, cite those sources, and state plainly when no source is available.",
  "risk-analyst":
    "Investigate policies, transaction monitoring, and control evidence. Separate evidence, inference, and unresolved risk. When evidence conflicts and no source precedence can be established, withhold the decision and call ask_person with the exact unresolved question; do not merely recommend escalation in prose. After calling it, ask the question plainly and stop.",
};

async function runAgent(
  input: RunAgentInput,
  profile: string | null,
  permit: RunPermit,
): Promise<Response> {
  const encoder = new EventEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const utf8 = new TextEncoder();
      const send = (event: BaseEvent) =>
        controller.enqueue(utf8.encode(encoder.encodeSSE(event)));
      const lease = new RunPermitLease(operations, permit);
      const debtBefore = await changedPaths(CODEX_WORKSPACE);
      let child: ReturnType<typeof spawnAppServer>;
      try {
        child = spawnWithPermit(lease, spawnAppServer);
      } catch (error) {
        send({
          type: "RUN_ERROR",
          message: asError(error, "Codex app-server could not start").message,
        } as BaseEvent);
        lease.finish(false);
        controller.close();
        return;
      }
      const write = async (value: Json) => {
        child.stdin.write(`${JSON.stringify(value)}\n`);
        await child.stdin.flush();
      };
      let nextId = 1;
      const pending = new RequestWaiters<Json>(REQUEST_TIMEOUT_MS);
      const request = (method: string, params: Json) =>
        (() => {
          const id = nextId++;
          return pending.request(id, () => write({ id, method, params }));
        })();
      const nextToolRun = toolRunAssertionsOf(input);
      const deploymentTools = deploymentToolsOf(input);
      const toolNames = codexToolNames(
        (input.tools ?? []).map((tool) => tool.name),
      );
      const messageId = crypto.randomUUID();
      let textStarted = false;
      let completed = false;
      let toolCalls = 0;
      let runError: string | null = null;
      let succeeded = false;
      let runAnalytics: CodexRunAnalytics = {
        model: MODEL ?? "account default",
      };

      send({
        type: "RUN_STARTED",
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      const reader = child.stdout.getReader();
      let stderrTail = "";
      const stderrPump = (async () => {
        const stderrReader = child.stderr.getReader();
        while (true) {
          const { value, done } = await stderrReader.read();
          if (done) break;
          stderrTail = (
            stderrTail + new TextDecoder().decode(value, { stream: true })
          ).slice(-4_096);
        }
      })();
      const childDeath = child.exited.then((code) => {
        if (completed) return;
        const failure = childExitError(code);
        if (stderrTail.trim()) {
          console.warn(
            "Codex app-server exited; stderr was drained and withheld from the user response.",
            {
              code,
              stderrCharacters: stderrTail.length,
            },
          );
        }
        pending.rejectAll(failure);
        runError = failure.message;
        completed = true;
      });
      const pump = (async () => {
        try {
          let buffer = "";
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += new TextDecoder().decode(value, { stream: true });
            let newline = buffer.indexOf("\n");
            while (newline >= 0) {
              const line = buffer.slice(0, newline).trim();
              buffer = buffer.slice(newline + 1);
              newline = buffer.indexOf("\n");
              if (!line) continue;
              const event = parseAppServerLine(line) as Json;
              if (
                typeof event.id === "number" &&
                (event.result || event.error)
              ) {
                if (event.error) {
                  const detail = event.error as Json;
                  pending.reject(
                    event.id,
                    new Error(String(detail.message ?? "Codex request failed")),
                  );
                } else {
                  pending.resolve(event.id, event);
                }
                continue;
              }
              const usage = usageFromNotification(event);
              if (usage) runAnalytics = { ...runAnalytics, ...usage };
              if (event.method === "item/agentMessage/delta") {
                const delta = (event.params as Json).delta;
                if (typeof delta === "string") {
                  if (!textStarted) {
                    textStarted = true;
                    send({
                      type: "TEXT_MESSAGE_START",
                      messageId,
                      role: "assistant",
                    } as BaseEvent);
                  }
                  send({
                    type: "TEXT_MESSAGE_CONTENT",
                    messageId,
                    delta,
                  } as BaseEvent);
                }
              } else if (
                event.method === "item/tool/call" &&
                typeof event.id === "number"
              ) {
                const params = event.params as Json;
                toolCalls += 1;
                const codexName = String(params.tool ?? "");
                const name =
                  toolNames.originalByAlias.get(codexName) ?? codexName;
                const args = (params.arguments ?? {}) as Json;
                const findings = inspectToolArguments(args);
                const protectedContent = contentRefusal(findings);
                const explicitlyAllowedSecret =
                  ALLOW_SECRET_TOOL_ARGS &&
                  findings.length > 0 &&
                  findings.every((finding) => finding.category === "secret");
                const blockingContent = explicitlyAllowedSecret
                  ? null
                  : protectedContent;
                const toolCallId = String(params.callId ?? crypto.randomUUID());
                send({
                  type: "TOOL_CALL_START",
                  toolCallId,
                  toolCallName: name,
                  parentMessageId: messageId,
                } as BaseEvent);
                send({
                  type: "TOOL_CALL_ARGS",
                  toolCallId,
                  delta: JSON.stringify(
                    protectedContent
                      ? {
                          redacted: true,
                          categories: [
                            ...new Set(
                              findings.map((finding) => finding.category),
                            ),
                          ],
                        }
                      : args,
                  ),
                } as BaseEvent);
                send({ type: "TOOL_CALL_END", toolCallId } as BaseEvent);
                const overLimit = toolCalls > MAX_TOOL_CALLS;
                operations.recordToolCall(
                  Boolean(overLimit || blockingContent),
                );
                const output = overLimit
                  ? `Refused. This run exceeded its limit of ${MAX_TOOL_CALLS} tool calls.`
                  : deploymentTools.has(name)
                    ? (blockingContent ??
                      (await callTool(nextToolRun(), name, args)))
                    : "This tool is owned by the OpenBot surface and has been handed back to it.";
                send(toolCallResultEvent(toolCallId, output));
                await write({
                  id: event.id,
                  result: {
                    contentItems: [{ type: "inputText", text: output }],
                    success: !overLimit && !blockingContent,
                  },
                });
                if (overLimit) {
                  runError = output;
                  completed = true;
                }
              } else if (event.method === "turn/completed") {
                completed = true;
              } else if (event.method === "error") {
                const params = event.params as Json;
                send({
                  type: "RUN_ERROR",
                  message: String(params.message ?? "Codex app-server error"),
                } as BaseEvent);
                completed = true;
              }
            }
          }
        } catch (error) {
          const failure = asError(error, "Codex app-server stream failed");
          pending.rejectAll(failure);
          runError = failure.message;
          completed = true;
          child.kill();
        }
      })();

      try {
        await request("initialize", {
          clientInfo: { name: "openbot", title: "OpenBot", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        });
        await write({ method: "initialized", params: {} });
        const dynamicTools = (input.tools ?? []).map((tool) => ({
          type: "function",
          name: toolNames.aliasByOriginal.get(tool.name) ?? tool.name,
          description: tool.description ?? "",
          inputSchema: tool.parameters ?? { type: "object" },
        }));
        const started = await request("thread/start", {
          ...(MODEL ? { model: MODEL } : {}),
          cwd: CODEX_WORKSPACE,
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: true,
          serviceName: "openbot",
          dynamicTools,
          baseInstructions: `You are an OpenBot coworker. Use only the dynamic tools supplied by OpenBot for actions. Do not use local shell or file tools. ${PROFILE_INSTRUCTIONS[profile ?? ""] ?? ""}`,
        });
        runAnalytics = {
          ...runAnalytics,
          model: modelFromThreadStart(started, runAnalytics.model),
        };
        const threadId = String(
          ((started.result as Json)?.thread as Json)?.id ?? "",
        );
        await request("turn/start", {
          threadId,
          input: [{ type: "text", text: promptOf(input) }],
        });
        const deadline = Date.now() + TURN_TIMEOUT_MS;
        while (!completed && Date.now() < deadline) await Bun.sleep(20);
        if (!completed) {
          runError = `Codex turn exceeded its ${TURN_TIMEOUT_MS}ms timeout.`;
        }
        const debt = await assessTechnicalDebt({
          cwd: CODEX_WORKSPACE,
          before: debtBefore,
          budget: DEBT_BUDGET,
        });
        if (debt.violations.length > 0) {
          runError = `Technical-debt review required: ${debt.violations.join("; ")}`;
        }
        if (textStarted)
          send({ type: "TEXT_MESSAGE_END", messageId } as BaseEvent);
        if (runError) {
          send({
            type: "RUN_ERROR",
            message: runError,
            openbotDebt: debt,
          } as BaseEvent);
        } else {
          send({
            type: "RUN_FINISHED",
            threadId: input.threadId,
            runId: input.runId,
            result: { openbotAnalytics: runAnalytics, openbotDebt: debt },
          } as BaseEvent);
          succeeded = true;
        }
      } catch (error) {
        send({
          type: "RUN_ERROR",
          message:
            error instanceof Error ? error.message : "Codex adapter failed",
        } as BaseEvent);
      } finally {
        pending.rejectAll(
          new Error("Codex run ended before the request completed."),
        );
        lease.finish(succeeded);
        child.kill();
        await Promise.allSettled([pump, stderrPump, childDeath]);
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": encoder.getContentType(),
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 120,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health")
      return Response.json({
        status: "ok",
        provider: "codex-subscription",
        model: MODEL ?? "account default",
        osSandbox: USE_MACOS_SANDBOX ? "macos-seatbelt" : "codex-read-only",
        secretToolArguments: ALLOW_SECRET_TOOL_ARGS
          ? "allowed-and-redacted"
          : "blocked",
        budget: operations.snapshot(),
      });
    if (url.pathname === "/metrics") {
      if (!hasManagedAgentToken(request, MANAGED_AGENT_TOKEN))
        return new Response("Unauthorized.\n", { status: 401 });
      return new Response(operations.prometheus(), {
        headers: { "content-type": "text/plain; version=0.0.4" },
      });
    }
    if (url.pathname === "/ag-ui" && request.method === "POST") {
      if (!hasManagedAgentToken(request, MANAGED_AGENT_TOKEN))
        return Response.json({ error: "Unauthorized." }, { status: 401 });
      const input = (await request.json()) as RunAgentInput;
      const permit = await operations.begin();
      if ("refused" in permit) {
        return Response.json({ error: permit.refused }, { status: 429 });
      }
      return runAgent(input, url.searchParams.get("profile"), permit);
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  },
});

console.info(`agent-codex listening on http://localhost:${PORT}/ag-ui`);
