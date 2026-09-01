export type ToolAuditEvidence = {
  id: string;
  targetId: string | null;
  eventType:
    | "mcp.call_succeeded"
    | "mcp.call_failed"
    | "mcp.call_rejected"
    | "agent.handoff_delivered"
    | "agent.handoff_refused";
};

export type ToolEvidenceVerdict = {
  passed: boolean;
  observed: string[];
  matched: string[];
  unmatched: string[];
  operationalFailures: string[];
  /** Failures after which no later governed execution succeeded. */
  unresolvedOperationalFailures: string[];
  rejected: string[];
  auditEventIds: string[];
};

/**
 * Match as a multiset: two observed calls require two authoritative success rows.
 *
 * This verifier deliberately knows nothing about prompt text or answer quality. It proves one
 * narrow claim only: each tool call the surface observed corresponds to a completed execution in
 * the deployment's append-only audit trail.
 */
export function verifyToolExecution(
  observed: readonly string[],
  audit: readonly ToolAuditEvidence[],
): ToolEvidenceVerdict {
  const remaining = [...audit];
  const matched: string[] = [];
  const unmatched: string[] = [];
  const operationalFailures: string[] = [];
  let lastOperationalFailure = -1;
  let lastOperationalSuccess = -1;
  const rejected: string[] = [];
  const auditEventIds: string[] = [];

  for (const ref of observed) {
    const index = remaining.findIndex((row) => row.targetId === ref);
    if (index < 0) {
      unmatched.push(ref);
      continue;
    }
    const [row] = remaining.splice(index, 1);
    if (!row) continue;
    matched.push(ref);
    if (row.eventType === "mcp.call_failed") {
      operationalFailures.push(ref);
      lastOperationalFailure = matched.length - 1;
    }
    if (
      row.eventType === "mcp.call_succeeded" ||
      row.eventType === "agent.handoff_delivered"
    ) {
      lastOperationalSuccess = matched.length - 1;
    }
    if (
      row.eventType === "mcp.call_rejected" ||
      row.eventType === "agent.handoff_refused"
    )
      rejected.push(ref);
    auditEventIds.push(row.id);
  }

  return {
    passed: observed.length > 0 && unmatched.length === 0,
    observed: [...observed],
    matched,
    unmatched,
    operationalFailures,
    unresolvedOperationalFailures:
      lastOperationalFailure > lastOperationalSuccess
        ? [operationalFailures.at(-1)].filter(
            (ref): ref is string => ref !== undefined,
          )
        : [],
    rejected,
    auditEventIds,
  };
}

export function toolRefFromModelName(name: string): string | null {
  if (name === "message_bot") return "bot/message_bot";
  const match = /^mcp__([^_][\s\S]*?)__([^_][\s\S]*)$/.exec(name);
  if (!match?.[1] || !match[2]) return null;
  return `${match[1]}/${match[2]}`;
}
