import { expect, test } from "bun:test";
import { artifactChecksum, verifyWorkflowEvidence } from "./workflow-runtime";

test("workflow proof is computed from artifact bytes, producer lineage, reviewer identity, and approval", () => {
  const content = "real captured output";
  const snapshot = {
    run: { status: "succeeded", approvedBy: "admin-1" },
    stages: [
      {
        stageId: "verify",
        status: "succeeded",
        sessionId: "worker-1",
        reviewerSessionId: "reviewer-1",
        verification: { accepted: true },
      },
    ],
    artifacts: [
      {
        stageId: "verify",
        content,
        checksum: artifactChecksum(content),
        revision: "abc123",
        producerSessionId: "worker-1",
        exitCode: 0,
      },
    ],
  };
  expect(verifyWorkflowEvidence(snapshot)).toMatchObject({
    terminal: true,
    verified: true,
  });
  snapshot.artifacts[0]!.content = "tampered output";
  expect(verifyWorkflowEvidence(snapshot)).toMatchObject({
    verified: false,
    checks: { artifactChecksums: false },
  });
});
