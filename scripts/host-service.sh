#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

setting() {
  local name="$1" fallback="$2" value
  value="$(grep -E "^$name=" "$ROOT/.env" | tail -1 | cut -d= -f2- | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" || true)"
  printf '%s' "${value:-$fallback}"
}

case "${1:-}" in
  agent-codex)
    export CODEX_AGENT_PORT="$(setting CODEX_AGENT_PORT 4202)"
    exec bun --env-file=.env agent-codex/src/index.ts
    ;;
  server)
    export PORT="$(setting SERVER_PORT 3001)"
    export COMPUTER_SUPERVISOR_URL="http://localhost:$(setting SUPERVISOR_PORT 4500)"
    export SUPERVISOR_TOKEN="$(setting SUPERVISOR_TOKEN openbot-dev-supervisor-token)"
    export COMPUTER_TOKEN="$(setting COMPUTER_TOKEN openbot-dev-computer-token)"
    export WORKER_SHARED_SECRET="$(setting WORKER_SHARED_SECRET openbot-dev-worker-secret)"
    cd server
    exec bun --env-file=../.env src/index.ts
    ;;
  worker)
    export DATABASE_URL="$(setting DATABASE_URL postgres://openbot:openbot@localhost:5433/openbot)"
    export SERVER_INTERNAL_URL="http://localhost:$(setting SERVER_PORT 3001)"
    export WORKER_SHARED_SECRET="$(setting WORKER_SHARED_SECRET openbot-dev-worker-secret)"
    exec bun --env-file=.env worker/src/index.ts
    ;;
  app)
    cd app
    exec bun run dev --port "$(setting APP_PORT 3010)" --strictPort
    ;;
  *)
    echo "Usage: $0 agent-codex|server|worker|app" >&2
    exit 2
    ;;
esac
