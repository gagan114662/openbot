import { eq } from "drizzle-orm";
import {
  buildContextCapsule,
  decidePromotion,
  evidenceHash,
  type DebtMetrics,
  type EvolutionContract,
} from "../../../shared/continuous-evolution";
import type { Database } from "../db/client";
import { evolutionCheckpoints } from "../db/schema";

const NO_MEASURED_DEBT: DebtMetrics = {
  addedDependencies: 0,
  complexityPoints: 0,
  duplicatedLines: 0,
  maximumFileLines: 0,
};

export type EvolutionCheckpoint = {
  chainId: string;
  stateHash: string;
  contextChecksum: string;
  version: number;
};

export function createEvolutionCheckpointGate(
  database: Database,
  options: { contract?: EvolutionContract; initialStateHash?: string } = {},
) {
  const contract: EvolutionContract = options.contract ?? {
    id: "openbot-handoff",
    version: "1",
    owner: "OpenBot runtime",
    goal: "Promote only verified handoff results built on the current trusted state.",
    constraints: ["Never advance a stale or failed chain."],
    definitionOfDone: ["The addressed agent completed and returned a result."],
    rollbackPlan: "Keep the last promoted state hash and retry or escalate.",
    allowedPaths: ["handoff"],
    invariants: [
      {
        id: "bounded-chain",
        version: "1",
        statement:
          "A result must descend from the current promoted checkpoint.",
        critical: true,
      },
    ],
    requiredVerifiers: ["delivery", "tool-call-budget", "relay-contract"],
    minimumNovelCases: 1,
    minimumMutationScore: 0,
    debtBudget: {
      addedDependencies: 0,
      complexityPoints: 50,
      duplicatedLines: 10,
      maximumFileLines: 500,
    },
    risk: "low",
  };
  const initial = options.initialStateHash ?? evidenceHash("openbot:initial");

  async function ensure(chainId: string) {
    await database
      .insert(evolutionCheckpoints)
      .values({
        chainId,
        stateHash: initial,
        version: 0,
        evidenceHash: evidenceHash({ chainId, stateHash: initial, version: 0 }),
      })
      .onConflictDoNothing();
  }

  return {
    async checkpoint(chainId: string): Promise<EvolutionCheckpoint> {
      await ensure(chainId);
      const [row] = await database
        .select()
        .from(evolutionCheckpoints)
        .where(eq(evolutionCheckpoints.chainId, chainId))
        .limit(1);
      if (!row)
        throw new Error("persistent evolution checkpoint could not be loaded");
      const capsule = buildContextCapsule({
        contract,
        parentStateHash: row.stateHash,
        approvedMemory: [],
      });
      return {
        chainId,
        stateHash: row.stateHash,
        version: row.version,
        contextChecksum: capsule.checksum,
      };
    },

    async promote(input: {
      checkpoint: EvolutionCheckpoint;
      candidateId: string;
      answer: string;
      debt?: DebtMetrics;
      verification?: {
        toolCallCount: number;
        maximumToolCalls: number;
        relayRequired: boolean;
      };
    }) {
      await ensure(input.checkpoint.chainId);
      return database.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(evolutionCheckpoints)
          .where(eq(evolutionCheckpoints.chainId, input.checkpoint.chainId))
          .for("update")
          .limit(1);
        if (!current)
          throw new Error("persistent evolution checkpoint disappeared");
        const capsule = buildContextCapsule({
          contract,
          parentStateHash: input.checkpoint.stateHash,
          approvedMemory: [],
        });
        if (capsule.checksum !== input.checkpoint.contextChecksum)
          throw new Error("checkpoint context checksum is stale or altered");
        const parentVerified =
          current.stateHash === input.checkpoint.stateHash &&
          current.version === input.checkpoint.version;
        const verification = input.verification ?? {
          toolCallCount: 0,
          maximumToolCalls: 32,
          relayRequired: true,
        };
        const verifierResults = [
          {
            id: "delivery",
            passed: input.answer.trim().length > 0,
            evidenceHash: evidenceHash(input.answer),
          },
          {
            id: "tool-call-budget",
            passed: verification.toolCallCount <= verification.maximumToolCalls,
            evidenceHash: evidenceHash(verification),
          },
          {
            id: "relay-contract",
            passed:
              !verification.relayRequired || input.answer.trim().length > 0,
            evidenceHash: evidenceHash({
              relayRequired: verification.relayRequired,
              answerPresent: input.answer.trim().length > 0,
            }),
          },
          {
            id: "invariant:bounded-chain@1",
            passed: parentVerified,
            evidenceHash: evidenceHash({
              chainId: input.checkpoint.chainId,
              expectedVersion: input.checkpoint.version,
              observedVersion: current.version,
            }),
          },
        ];
        const decision = decidePromotion({
          contract,
          trustedStateHash: current.stateHash,
          capsule,
          approvedMemory: [],
          candidate: {
            id: input.candidateId,
            parentStateHash: input.checkpoint.stateHash,
            finalStateHash: evidenceHash({
              parent: input.checkpoint.stateHash,
              answer: input.answer,
            }),
            contextChecksum: capsule.checksum,
            changedPaths: ["handoff/result"],
            verifierResults,
            novelCases: {
              total: verifierResults.length,
              passed: verifierResults.filter((result) => result.passed).length,
              suiteHash: evidenceHash(verifierResults),
            },
            // Text is not an artifact: an answer can discuss or display a patch without applying
            // it. Only an execution layer that actually changed state may supply measured debt.
            mutationScore: 0,
            debt: input.debt ?? NO_MEASURED_DEBT,
          },
        });
        if (decision.promoted) {
          await tx
            .update(evolutionCheckpoints)
            .set({
              stateHash: decision.nextStateHash,
              version: current.version + 1,
              evidenceHash: decision.evidenceHash,
              updatedAt: new Date(),
            })
            .where(eq(evolutionCheckpoints.chainId, input.checkpoint.chainId));
        }
        return decision;
      });
    },

    async state(chainId: string) {
      return (await this.checkpoint(chainId)).stateHash;
    },
  };
}

export type EvolutionCheckpointGate = ReturnType<
  typeof createEvolutionCheckpointGate
>;
