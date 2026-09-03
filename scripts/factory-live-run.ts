const args = process.argv.slice(2);
const value = (flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const baseUrl = value("--base-url") ?? "http://localhost:3001";
const kind = value("--kind") ?? "ci-repair";
const objective = value("--objective");
const path = value("--path");
const expectedContent = value("--expected-content");
const sessionCookie = process.env.OPENBOT_SESSION_COOKIE;
if (!objective || !path || expectedContent === undefined || !sessionCookie)
  throw new Error(
    "Set OPENBOT_SESSION_COOKIE and pass --objective, --path, and --expected-content.",
  );

const response = await fetch(`${baseUrl}/api/software-factory/jobs`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    cookie: sessionCookie,
  },
  body: JSON.stringify({
    kind,
    tier: "managed",
    objective,
    trigger: "factory-live-run",
    minimumQuality: 0.8,
    maximumAttempts: 3,
    concurrencyLimit: 1,
    requiredContext: [],
    observableChange: { path, expectedContent },
  }),
});
const body = await response.text();
if (!response.ok)
  throw new Error(`Factory launch failed (${response.status}): ${body}`);
console.log(body);
