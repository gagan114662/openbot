# Issue #35 — headed UI double-click proof (2026-09-04)

Stack: branch `claude/issue-35-idempotent-fix-drafting` @ `54e0ac4`, server :3021
(single-user admin mode, `OPENBOT_SINGLE_USER=true`, no identity provider), Vite app :3030,
shared dev Postgres :5433. The admin page's own provenance row showed
`claude/issue-35-idempotent-fix-drafting @ 54e0ac42… · CLEAN`.

Scenario: production issue `7897fd5f-2169-4d11-8480-8f8383c26882`
("UI double-click proof run B (#35)"); its **Draft fix PR** button was clicked twice in the
same event tick (synchronous double click on one button element).

Network (same signed-in session):

    POST /api/production-engineer/issues/7897fd5f-…/fix → 202 (78B)
    POST /api/production-engineer/issues/7897fd5f-…/fix → 409 (179B)

409 body, captured live while the fix was running:

    {"error":"A fix is already running or awaiting review for this issue.",
     "fixId":"56229912-3a03-4dc7-9fcd-40eb3413ba92",
     "fixStatus":"running","fixBranch":null,"pullRequestUrl":null}

Database row at that moment: `fix_status=running`,
`fix_claim_id=56229912-3a03-4dc7-9fcd-40eb3413ba92` (matches the 409's fixId),
`human_approved_by=dev-local-user`.

Screenshots (viewport, captioned):
- `issue-35-ui-before-doubleclick.png` — the issue row with its **Draft fix PR** button.
- `issue-35-ui-after-doubleclick.png` — the same row showing a single **Drafting…** after two clicks.

Outcome: the real drafter ran once, failed honestly on `codex` 401 (no credits), issue ended
`fix_status=failed` with exactly one claim id; zero production worktrees and branches remained.
