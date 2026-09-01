import { parse } from "yaml";
import {
  verifyGrounding,
  verifyMoneyTotal,
  verifyRiskFlags,
} from "../shared/domain-verifiers";

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
