import { randomUUID } from "node:crypto";

const processInstanceId = randomUUID();

export const processOwner = (
  role: string,
  environment: NodeJS.ProcessEnv = process.env,
) => `${role}/${environment.HOSTNAME ?? "local"}/${processInstanceId}`;
