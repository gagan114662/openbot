import { verifyRuntimeEpisode } from "../server/src/analytics/runtime-verification";

const result = verifyRuntimeEpisode({
  run: {
    runId: "ci-recorded-runtime-episode",
    threadId: "ci-thread",
    messages: [
      { id: "question", role: "user", content: "Verify the cited source." },
    ],
    tools: [],
    state: {},
    forwardedProps: {},
  },
  requireGrounding: true,
  events: [
    {
      type: "TOOL_CALL_RESULT",
      toolCallId: "source",
      content: "retrieved https://example.com/evidence",
    },
    {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "answer",
      delta: "Verified from https://example.com/evidence",
    },
  ] as never,
});

process.stdout.write(`${JSON.stringify({ episode: result.episode })}\n`);
