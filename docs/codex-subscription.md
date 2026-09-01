# Use OpenBot with a Codex subscription

This fork includes `agent-codex`, a host-side AG-UI adapter for Codex app-server. It uses the login
already held by the Codex desktop app or CLI, including **Sign in with ChatGPT**, and exposes
OpenBot's governed tools as Codex dynamic tools. Tool execution still returns through OpenBot's
gateway, policy checks, and audit trail.

## Setup

1. Sign in and verify the session:

   ```sh
   codex login
   codex login status
   ```

2. Follow the normal OpenBot setup for Docker and CopilotKit Intelligence. Leave
   `OPENAI_API_KEY` empty unless you also want to run the API-key-backed example Bots.

3. Run `bun install`, then `bash scripts/start.sh`.

The adapter runs on the host (port 4202 by default), where it can use the OS keychain-backed Codex
login. Set `CODEX_MODEL` to override the model selected by your account. This is intended for a
private local deployment; do not expose the adapter publicly or copy the Codex credential store
into containers.

Credential-shaped tool arguments are blocked by default. Set
`CODEX_ALLOW_SECRET_TOOL_ARGS=true` only when an approved OpenBot tool must receive a credential.
The raw value is forwarded to that approved tool but remains redacted from AG-UI events and logs.
Social-security numbers, payment cards, prompt-injection content, mixed sensitive payloads, and
unapproved tools remain blocked or unexecuted.

Keep OrbStack running while using OpenBot. For database integration tests, use a separate migrated
database instead of the live `openbot` database; otherwise the running worker can legitimately
claim rows created by a test and make the result nondeterministic.
