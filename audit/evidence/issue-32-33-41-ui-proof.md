# Headed UI proofs for #32, #33, #41 (2026-09-04)

All three fixes are already on `main` (phase-1 stack) with named tests and mutation
checks verified earlier. These are the remaining **headed-UI** criteria, driven against a
real stack booted from `main @ 70378de`: server on :3021 in single-user admin mode
(`OPENBOT_SINGLE_USER=true`, no identity provider), Vite app on :3030, shared dev
Postgres on :5433. The admin page's "Running build provenance" row displays the commit,
so every screenshot is self-attributing.

Deterministic harness note (disclosed): a local `codex`/`claude` stand-in on PATH lets
the worker/reviewer complete without a model or network — used only to reach the states
the UI criteria need. Where the model router selected a seeded **benchmark** model
(`stale-session-drill`, `claude/sonnet`) it invoked the real CLI instead, which errors on
an unauthenticated account; that is called out per-issue below and never changes what the
criterion asks for.

## #33 — operator-visible worker id (criterion 3)

Two consecutive server restarts, worker id read from the admin page's provenance row:

- Restart 1 (`HOSTNAME` unset): `software-factory/local/3485036b-f24b-4bb3-80f9-7081dee2fd96`
- Restart 2 (`HOSTNAME=drill`): `software-factory/drill/2772e7f6-4097-4f46-a7e2-64817bf64471`

The per-process random component differs (`3485036b…` vs `2772e7f6…`) and the hostname
segment tracks `HOSTNAME`. Screenshots: `issue-33-worker-id-restart1.png`,
`issue-33-worker-id-restart2.png`. Harness-independent — fully clean.

## #41 — UI performs the gate decision (criterion 6)

Run `75d1f944-4231-4124-bd22-93ba7693179e`, a three-stage ci-repair graph, driven through
the admin page to `awaiting_approval` at the mid-graph human gate (reaching the gate
required a full worker+reviewer cycle to succeed, served by the deterministic stand-in).
`issue-41-gate-paused-reject.png` shows the paused run: the stage graph
(diagnose succeeded → **repair awaiting_approval** → verify pending), the gate prompt
("Approve diagnosis before the repair changes the candidate"), both **Approve stage** /
**Reject with feedback** buttons, and the feedback text typed in.

A signed-in headed-browser click on **Reject with feedback** returned `200` on
`POST /api/software-factory/workflows/75d1f944…/stages/repair/decision` and re-queued the
producing stage (`diagnose`: succeeded → pending → running). The exact feedback string
—"Rejected for #41 UI proof: include the failing seed and a rollback plan before
repairing."— is durably recorded in three places anyone with the `.env` can query:

- Audit row `39ef8280-b4f2-46f5-ad36-4fdd9df3410b`: `workflow.control_applied`,
  action `stage_reject`, `producerStageId: diagnose`, with a `feedbackHash`.
- Human-decision artifact `6f4324bf-2d41-49af-b8a6-c91bc077461b`
  (`factory_workflow_artifacts.kind = 'human-decision'`): `actorId: dev-local-user`,
  `decision: reject`, the exact `feedback`, `producerStageId: diagnose`,
  `revision: 70378de…`.
- The gated `repair` stage's `checks.gate.feedback` holds the exact string durably.

(After the reject, the re-queued `diagnose` re-ran under a router-selected benchmark model
that invoked the real CLI and the run aborted on auth — expected with no credits, and
irrelevant to the decision proof above.)

## #32 — UI terminal-state at the attempt cap (criterion 4)

Run `16e2493b-184c-465d-a7ca-03f8c06c38f5`, launched through the admin page with
`repair cap 2`. It exhausted both attempts on the `diagnose` stage and went terminal —
never stuck in `running`. `issue-32-attempt-cap-failed.png` shows the run:
`failed · 0/3 stages · repair cap 2`, `diagnose · failed · attempt 2/2`.

The `factory_workflow_events` rows for the last two transitions, both at
`2026-09-04 18:10:16.069278+00`:

- `88e06613-f74d-4721-9e42-cedd2f8ffa88` — stage `diagnose`: `running → failed`
- `b317e41d-045b-4895-a1fb-3eb45ceac504` — run: `running → failed`

Honesty note: attempts were exhausted because the router selected the seeded benchmark
model `stale-session-drill`, which routes to the real Codex CLI and errored on an
unauthenticated account, rather than by the deterministic stand-in. The criterion asks
only that a run driven to its attempt cap through the admin page reach a terminal state
with the last two transition rows shown — which this demonstrates, and real repeated
harness failures exhausting the cap is a faithful instance of it.
