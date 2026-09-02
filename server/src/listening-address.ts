export const listeningHost = (environment: NodeJS.ProcessEnv): string =>
  environment.SERVER_HOST ?? "localhost";

export const listeningUrl = (host: string, port: number): string => {
  const urlHost =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
};
