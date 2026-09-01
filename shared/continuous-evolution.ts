import { createHash } from "node:crypto";

export type EvolutionInvariant = {
  id: string;
  version: string;
  statement: string;
  critical: boolean;
};

export type EvolutionContract = {
  id: string;
  version: string;
  owner: string;
  goal: string;
  constraints: string[];
  definitionOfDone: string[];
  rollbackPlan: string;
  allowedPaths: string[];
  invariants: EvolutionInvariant[];
  requiredVerifiers: string[];
  minimumNovelCases: number;
  minimumMutationScore: number;
  debtBudget: DebtMetrics;
  risk: "low" | "medium" | "high";
};

export type DebtMetrics = {
  addedDependencies: number;
  complexityPoints: number;
  duplicatedLines: number;
  maximumFileLines: number;
};

export type ReviewedMemory = {
  id: string;
  text: string;
  source: string;
  approvedBy: string;
  approvedAt: string;
};

export type ContextCapsule = {
  contractId: string;
  contractVersion: string;
  parentStateHash: string;
  invariants: EvolutionInvariant[];
  approvedMemory: ReviewedMemory[];
  checksum: string;
};

export type EvolutionCandidate = {
  id: string;
  parentStateHash: string;
  finalStateHash: string;
  contextChecksum: string;
  changedPaths: string[];
  verifierResults: Array<{ id: string; passed: boolean; evidenceHash: string }>;
  novelCases: { total: number; passed: number; suiteHash: string };
  mutationScore: number;
  debt: DebtMetrics;
  approval?: {
    candidateHash: string;
    approvedBy: string;
    approvedAt: string;
  };
};

export type PromotionDecision = {
  promoted: boolean;
  candidateId: string;
  candidateHash: string;
  previousStateHash: string;
  nextStateHash: string;
  reasons: string[];
  evidenceHash: string;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function evidenceHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function nonEmpty(values: string[]): boolean {
  return values.length > 0 && values.every((value) => value.trim().length > 0);
}

export function validateEvolutionContract(contract: EvolutionContract): string[] {
  const reasons: string[] = [];
  if (
    !contract.id.trim() ||
    !contract.version.trim() ||
    !contract.owner.trim() ||
    !contract.goal.trim()
  ) {
    reasons.push("contract identity, owner, version, and goal are required");
  }
  if (!nonEmpty(contract.constraints)) reasons.push("constraints are required");
  if (!nonEmpty(contract.definitionOfDone)) {
    reasons.push("a definition of done is required");
  }
  if (!contract.rollbackPlan.trim()) reasons.push("a rollback plan is required");
  if (!nonEmpty(contract.allowedPaths)) reasons.push("allowed paths are required");
  if (contract.invariants.length === 0) reasons.push("invariants are required");
  const invariantKeys = contract.invariants.map(
    ({ id, version }) => `${id}@${version}`,
  );
  if (new Set(invariantKeys).size !== invariantKeys.length) {
    reasons.push("invariant ids and versions must be unique");
  }
  if (!nonEmpty(contract.requiredVerifiers)) {
    reasons.push("independent verifiers are required");
  }
  if (
    !Number.isInteger(contract.minimumNovelCases) ||
    contract.minimumNovelCases < 1
  ) {
    reasons.push("at least one novel verification case is required");
  }
  if (
    !Number.isFinite(contract.minimumMutationScore) ||
    contract.minimumMutationScore < 0 ||
    contract.minimumMutationScore > 1
  ) {
    reasons.push("mutation score must be between zero and one");
  }
  for (const [metric, limit] of Object.entries(contract.debtBudget)) {
    if (!Number.isFinite(limit) || limit < 0) {
      reasons.push(`debt budget ${metric} must be finite and non-negative`);
    }
  }
  return reasons;
}

/**
 * Build the complete, hash-bound context an agent must use for a candidate.
 *
 * Memory is accepted here only after the tenant-package layer has performed its human-review gate.
 * Sorting makes the checksum independent of retrieval order and sensitive to missing invariants.
 */
export function buildContextCapsule(input: {
  contract: EvolutionContract;
  parentStateHash: string;
  approvedMemory: ReviewedMemory[];
}): ContextCapsule {
  const contractReasons = validateEvolutionContract(input.contract);
  if (contractReasons.length > 0) throw new Error(contractReasons.join("; "));
  if (!input.parentStateHash.trim()) throw new Error("parent state hash is required");
  const approvedMemory = [...input.approvedMemory].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  for (const memory of approvedMemory) {
    if (
      !memory.id.trim() ||
      !memory.text.trim() ||
      !memory.source.trim() ||
      !memory.approvedBy.trim() ||
      !Number.isFinite(Date.parse(memory.approvedAt))
    ) {
      throw new Error(`reviewed memory ${memory.id || "<unknown>"} is incomplete`);
    }
  }
  const content = {
    contractId: input.contract.id,
    contractVersion: input.contract.version,
    parentStateHash: input.parentStateHash,
    invariants: [...input.contract.invariants].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
    approvedMemory,
  };
  return { ...content, checksum: evidenceHash(content) };
}

export function hashCandidate(candidate: EvolutionCandidate): string {
  const { approval, ...unsignedCandidate } = candidate;
  void approval;
  return evidenceHash(unsignedCandidate);
}

function pathAllowed(path: string, allowed: string[]): boolean {
  return allowed.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Fail-closed promotion for one step in a continuous evolution chain.
 *
 * A failed candidate never advances state. A later candidate based on its untrusted output therefore
 * has the wrong parent and is rejected before its own test score can matter.
 */
export function decidePromotion(input: {
  contract: EvolutionContract;
  trustedStateHash: string;
  capsule: ContextCapsule;
  approvedMemory: ReviewedMemory[];
  candidate: EvolutionCandidate;
}): PromotionDecision {
  const { contract, trustedStateHash, capsule, approvedMemory, candidate } = input;
  const reasons = validateEvolutionContract(contract);
  const candidateHash = hashCandidate(candidate);
  if (candidate.parentStateHash !== trustedStateHash) {
    reasons.push("candidate is based on an untrusted or stale parent state");
  }
  if (candidate.finalStateHash === candidate.parentStateHash) {
    reasons.push("candidate does not change the trusted state");
  }
  if (reasons.length === 0) {
    const expectedCapsule = buildContextCapsule({
      contract,
      parentStateHash: trustedStateHash,
      approvedMemory,
    });
    if (
      capsule.checksum !== expectedCapsule.checksum ||
      evidenceHash({
        contractId: capsule.contractId,
        contractVersion: capsule.contractVersion,
        parentStateHash: capsule.parentStateHash,
        invariants: capsule.invariants,
        approvedMemory: capsule.approvedMemory,
      }) !== capsule.checksum
    ) {
      reasons.push("context capsule is stale, incomplete, or altered");
    }
    if (candidate.contextChecksum !== expectedCapsule.checksum) {
      reasons.push("candidate is not bound to the current complete context capsule");
    }
  }
  const disallowedPaths = candidate.changedPaths.filter(
    (path) => !pathAllowed(path, contract.allowedPaths),
  );
  if (disallowedPaths.length > 0) {
    reasons.push(`candidate changes disallowed paths: ${disallowedPaths.join(", ")}`);
  }
  const results = new Map(candidate.verifierResults.map((result) => [result.id, result]));
  for (const verifier of contract.requiredVerifiers) {
    const result = results.get(verifier);
    if (!result?.passed || !result.evidenceHash.trim()) {
      reasons.push(`required verifier did not pass with evidence: ${verifier}`);
    }
  }
  for (const invariant of contract.invariants) {
    const result = results.get(`invariant:${invariant.id}@${invariant.version}`);
    if (invariant.critical && (!result?.passed || !result.evidenceHash.trim())) {
      reasons.push(`critical invariant did not pass: ${invariant.id}@${invariant.version}`);
    }
  }
  if (
    !Number.isInteger(candidate.novelCases.total) ||
    candidate.novelCases.total < contract.minimumNovelCases ||
    candidate.novelCases.passed !== candidate.novelCases.total ||
    !candidate.novelCases.suiteHash.trim()
  ) {
    reasons.push("novel-input verification is missing, insufficient, or failing");
  }
  if (
    !Number.isFinite(candidate.mutationScore) ||
    candidate.mutationScore < contract.minimumMutationScore ||
    candidate.mutationScore > 1
  ) {
    reasons.push("mutation score is below the contract threshold");
  }
  for (const [metric, observed] of Object.entries(candidate.debt)) {
    const limit = contract.debtBudget[metric as keyof DebtMetrics];
    if (!Number.isFinite(observed) || observed < 0 || observed > limit) {
      reasons.push(`technical-debt budget exceeded: ${metric}`);
    }
  }
  if (contract.risk === "high") {
    const approval = candidate.approval;
    if (
      !approval ||
      approval.candidateHash !== candidateHash ||
      !approval.approvedBy.trim() ||
      !Number.isFinite(Date.parse(approval.approvedAt))
    ) {
      reasons.push("high-risk candidate lacks hash-bound human approval");
    }
  }
  const promoted = reasons.length === 0;
  const nextStateHash = promoted ? candidate.finalStateHash : trustedStateHash;
  return {
    promoted,
    candidateId: candidate.id,
    candidateHash,
    previousStateHash: trustedStateHash,
    nextStateHash,
    reasons,
    evidenceHash: evidenceHash({
      contract: `${contract.id}@${contract.version}`,
      candidateHash,
      previousStateHash: trustedStateHash,
      nextStateHash,
      reasons,
    }),
  };
}
