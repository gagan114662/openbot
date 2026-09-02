import { parse } from "yaml";
import {
  verifyGrounding,
  verifyMoneyTotal,
  verifyRiskFlags,
} from "../shared/domain-verifiers";
import {
  scoreEpisode,
  type VerifiableEpisode,
} from "../shared/verifiable-reward";

type Task = { id: string; version: string; verifier: string; input: unknown };
const suite = parse(await Bun.file("examples/fintech/evals.yaml").text()) as {
  version: number;
  tasks: Task[];
};

const verifiers: Record<
  string,
  (input: never) => { passed: boolean; evidence: unknown }
> = {
  "money-total": verifyMoneyTotal,
  "source-grounding": verifyGrounding,
  "transaction-risk-flags": verifyRiskFlags,
};

let failures = 0;
for (const task of suite.tasks) {
  const verify = verifiers[task.verifier];
  if (!verify) throw new Error(`Unknown verifier: ${task.verifier}`);
  const result = verify(task.input as never);
  console.log(`${result.passed ? "PASS" : "FAIL"} ${task.id}@${task.version}`);
  if (!result.passed) failures += 1;
}
if (failures > 0) process.exit(1);

const episodesFlag = process.argv.indexOf("--episodes");
if (episodesFlag >= 0) {
  const path = process.argv[episodesFlag + 1];
  if (!path) throw new Error("--episodes requires a JSONL path");
  const lines = (await Bun.file(path).text()).split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const record = JSON.parse(line) as
      | { episode?: VerifiableEpisode }
      | VerifiableEpisode;
    const episode =
      "episode" in record && record.episode
        ? record.episode
        : (record as VerifiableEpisode);
    const scored = scoreEpisode(episode);
    console.log(
      `${scored.eligibleForTraining ? "PASS" : "FAIL"} recorded:${episode.id}`,
    );
    if (!scored.eligibleForTraining) failures += 1;
  }
  if (lines.length === 0)
    throw new Error("The recorded episode file was empty.");
  if (failures > 0) process.exit(1);
}
