import { describe, expect, test } from "bun:test";
import { artifactChecksum, verifyWorkflowEvidence } from "./workflow-runtime";

type WorkflowEvidenceSnapshot = Parameters<typeof verifyWorkflowEvidence>[0];

const validSnapshot = (): WorkflowEvidenceSnapshot => {
  const content = "real captured output";
  return {
    run: {
      status: "succeeded",
      approvedBy: "admin-1" as string | null,
    },
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
};

test("workflow proof is computed from artifact bytes, producer lineage, reviewer identity, and approval", () => {
  const snapshot = validSnapshot();
  expect(verifyWorkflowEvidence(snapshot)).toMatchObject({
    terminal: true,
    readyForApproval: false,
    verified: true,
  });
  snapshot.artifacts[0]!.content = "tampered output";
  expect(verifyWorkflowEvidence(snapshot)).toMatchObject({
    verified: false,
    checks: { artifactChecksums: false },
  });
});

test("a machine-verified run is ready, but not verified, until a human approves it", () => {
  const snapshot = validSnapshot();
  snapshot.run = { status: "awaiting_approval", approvedBy: null };
  expect(verifyWorkflowEvidence(snapshot)).toMatchObject({
    terminal: true,
    readyForApproval: true,
    verified: false,
    checks: { humanApproval: false },
  });
});

test("an intermediate stage gate is pending, not a failed terminal proof", () => {
  const snapshot = validSnapshot();
  snapshot.run = { status: "awaiting_approval", approvedBy: null };
  snapshot.stages.push({
    stageId: "repair",
    status: "awaiting_approval",
    sessionId: null,
    reviewerSessionId: null,
    verification: {},
  });
  expect(verifyWorkflowEvidence(snapshot)).toMatchObject({
    terminal: false,
    readyForApproval: false,
    verified: false,
    checks: { allStagesSucceeded: false, humanApproval: false },
  });
});

describe("each workflow evidence check independently prevents verification", () => {
  const falsifications: Array<{
    check: string;
    mutate: (snapshot: ReturnType<typeof validSnapshot>) => void;
  }> = [
    {
      check: "allStagesSucceeded",
      mutate: (snapshot) => {
        snapshot.stages[0]!.status = "running";
      },
    },
    {
      check: "artifactChecksums",
      mutate: (snapshot) => {
        snapshot.artifacts[0]!.content = "tampered";
      },
    },
    {
      check: "revisionBound",
      mutate: (snapshot) => {
        snapshot.artifacts[0]!.revision = "";
      },
    },
    {
      check: "producerBound",
      mutate: (snapshot) => {
        snapshot.artifacts[0]!.producerSessionId = "another-worker";
      },
    },
    {
      check: "commandsSucceeded",
      mutate: (snapshot) => {
        snapshot.artifacts[0]!.exitCode = 1;
      },
    },
    {
      check: "freshReviewers",
      mutate: (snapshot) => {
        snapshot.stages[0]!.reviewerSessionId = "worker-1";
      },
    },
    {
      check: "acceptedStages",
      mutate: (snapshot) => {
        snapshot.stages[0]!.verification = { accepted: false };
      },
    },
    {
      check: "artifactsForSucceededStages",
      mutate: (snapshot) => {
        snapshot.artifacts.length = 0;
      },
    },
    {
      check: "humanApproval",
      mutate: (snapshot) => {
        snapshot.run.approvedBy = null;
      },
    },
  ];

  for (const { check, mutate } of falsifications) {
    test(`${check}=false makes verified=false`, () => {
      const snapshot = validSnapshot();
      mutate(snapshot);
      const evidence = verifyWorkflowEvidence(snapshot);
      expect(evidence.checks[check as keyof typeof evidence.checks]).toBe(
        false,
      );
      expect(evidence.verified).toBe(false);
    });
  }
});
