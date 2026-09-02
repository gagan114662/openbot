import { chmod, rename } from "node:fs/promises";
import { resolve } from "node:path";

type Provider = "google" | "microsoft" | "okta";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function environmentValue(source: string, name: string): string | undefined {
  return (
    source.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim() || undefined
  );
}

function setValue(source: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  if (pattern.test(source)) return source.replace(pattern, line);
  return `${source.replace(/\s*$/, "")}\n${line}\n`;
}

const provider = argument("--provider") as Provider | undefined;
const admin = argument("--admin")?.trim().toLowerCase();
const envPath = resolve(argument("--env-file") ?? ".env");
const clientJsonPath = argument("--client-json");

if (!provider || !["google", "microsoft", "okta"].includes(provider)) {
  throw new Error("Use --provider google, microsoft, or okta.");
}
if (!admin || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(admin)) {
  throw new Error(
    "Use --admin with the administrator's complete email address.",
  );
}

let source = await Bun.file(envPath).text();
const prefix = provider.toUpperCase();
if (clientJsonPath) {
  if (provider !== "google") {
    throw new Error(
      "--client-json currently accepts Google OAuth client JSON only.",
    );
  }
  const document = (await Bun.file(resolve(clientJsonPath)).json()) as {
    web?: { client_id?: unknown; client_secret?: unknown };
    installed?: { client_id?: unknown; client_secret?: unknown };
  };
  const client = document.web ?? document.installed;
  if (
    typeof client?.client_id !== "string" ||
    typeof client.client_secret !== "string"
  ) {
    throw new Error(
      "The Google OAuth client JSON has no client id or client secret.",
    );
  }
  source = setValue(source, "GOOGLE_OAUTH_CLIENT_ID", client.client_id);
  source = setValue(source, "GOOGLE_OAUTH_CLIENT_SECRET", client.client_secret);
}
const clientId = environmentValue(source, `${prefix}_OAUTH_CLIENT_ID`);
const clientSecret = environmentValue(source, `${prefix}_OAUTH_CLIENT_SECRET`);
if (!clientId || !clientSecret) {
  throw new Error(
    `${prefix}_OAUTH_CLIENT_ID and ${prefix}_OAUTH_CLIENT_SECRET must already be present in ${envPath}. Keep credentials out of command arguments and shell history.`,
  );
}
if (provider === "okta" && !environmentValue(source, "OKTA_OAUTH_ISSUER")) {
  throw new Error(
    "OKTA_OAUTH_ISSUER must already be present in the environment file.",
  );
}

const baseUrl =
  environmentValue(source, "BETTER_AUTH_URL") ?? "http://localhost:3001";
const trustedOrigins =
  environmentValue(source, "TRUSTED_ORIGINS") ?? "http://localhost:3010";
const sessionSecret =
  environmentValue(source, "BETTER_AUTH_SECRET") ??
  Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64");

source = setValue(source, "BETTER_AUTH_URL", baseUrl);
source = setValue(source, "TRUSTED_ORIGINS", trustedOrigins);
source = setValue(source, "INITIAL_ADMIN_EMAILS", admin);
source = setValue(source, "BETTER_AUTH_SECRET", sessionSecret);
source = setValue(source, "OPENBOT_SINGLE_USER", "false");

const temporaryPath = `${envPath}.identity-${crypto.randomUUID()}.tmp`;
await Bun.write(temporaryPath, source, { mode: 0o600 });
await rename(temporaryPath, envPath);
await chmod(envPath, 0o600);

console.log(
  `Identity configuration prepared atomically for ${provider}; single-user access is disabled. Restart OpenBot and complete a real sign-in before exposing it.`,
);
