/** Derive the listener and its operator-facing URL from the same configured host. */
export const serverBinding = (
  configuredHost: string | undefined,
  port: number,
) => {
  const hostname = configuredHost ?? "localhost";
  const urlHost = hostname.includes(":") ? `[${hostname}]` : hostname;
  return { hostname, url: `http://${urlHost}:${port}` };
};
