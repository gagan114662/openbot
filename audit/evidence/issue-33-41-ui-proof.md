# Headed UI proofs for #33 and #41 (2026-09-04)

Split out of PR #105, whose #32 section was superseded by `54cf6ff`
(`audit/evidence/issue-32-terminal-at-cap.md`). The #33 and #41 material below is
unchanged from that PR; only the superseded #32 section was dropped. See the closing
comment on #105 for why.

Driven against a real stack booted from `main @ 70378de`: server on :3021 in single-user
admin mode (`OPENBOT_SINGLE_USER=true`, no identity provider), Vite app on :3030, shared
dev Postgres on :5433. The admin page's "Running build provenance" row displays the
commit, so every screenshot is self-attributing.

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
`issue-33-worker-id-restart2.png`.

**Harness-independent.** The deterministic stand-in plays no part in this claim: the
worker id is assigned at process start, before any model is selected or invoked. Nothing
about the identity depends on a stage running, so the stand-in cannot affect it.

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

**Scope of the stand-in here.** It was needed to *reach* the gate, not to perform the
decision. The criterion asks that the UI perform the gate decision; the click, the `200`,
the re-queue of the producing stage, and the three durable records are all downstream of
the stand-in's work and independent of how the earlier stages completed.

(After the reject, the re-queued `diagnose` re-ran under a router-selected benchmark model
that invoked the real CLI and the run aborted on auth — expected with no credits, and
irrelevant to the decision proof above.)
