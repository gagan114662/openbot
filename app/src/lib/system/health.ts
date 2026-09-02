export type DeploymentHealth =
  | { status: "ok" }
  | {
      status: "unavailable";
      dependencies: { database: "unavailable" };
    };

export async function fetchDeploymentHealth(): Promise<DeploymentHealth> {
  const response = await fetch("/api/health");
  return response.json() as Promise<DeploymentHealth>;
}
