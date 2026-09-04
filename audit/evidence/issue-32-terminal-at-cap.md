# Issue #32 criterion 4 — a run driven to its attempt cap through the admin page reaches a terminal state

Date: 2026-09-04. Run `4567f8e7-cfbb-47fa-ab52-c4ce64e1ee83`, `repair cap 2`.

## The criterion

> **UI terminal-state proof.** A run driven to its attempt cap through the admin page
> (not the API) is shown with its run id, the `factory_workflow_events` rows for the last
> two transitions, and a screenshot captioned with those row timestamps.

## Driven through the admin page

Both operator actions were clicks in `/admin/production-engineer`, each confirmed by the
request the page issued:

| Operator action | Request the page made | Result |
| --- | --- | --- |
| Filled the "Launch a managed workflow" form (kind `ci-repair`, cap 2) and clicked **Launch managed run** | `POST /api/software-factory/jobs` | `201` |
| Clicked **Approve stage** on the `repair` human gate | `POST /api/software-factory/workflows/4567f8e7…/stages/repair/decision` | `200` |

No API call drove this run. The two POSTs above are the page's own network activity,
captured from the browser, not issued by hand.

## The last two transitions

`factory_workflow_events`, newest first:

| Event id | Entity | Transition | `attempts` | Timestamp (UTC) |
| --- | --- | --- | --- | --- |
| `2fc45472-5b49-45cc-8bcc-fda2fa71a2e6` | run | `running → failed` | — | `2026-09-04 21:11:02.399134+00` |
| `c75f1a27-9b77-446e-9b2c-efdee8f9e409` | stage | `running → failed` | **2** | `2026-09-04 21:11:02.399134+00` |

The run row records `status = failed`, `maximum_attempts = 2`,
`completed_at = 2026-09-04 21:11:02.413+00`. Both transitions carry the same timestamp:
they are written in one transaction, which is what stops the run from lingering in
`running` after its stage gives up.

Re-readable by anyone with the repo `.env`:

```sh
docker exec openbot-postgres-1 psql -U openbot -d openbot -c \
"select id, entity, from_status, to_status, detail->>'attempts' attempts, created_at
   from factory_workflow_events
  where run_id = '4567f8e7-cfbb-47fa-ab52-c4ce64e1ee83'
  order by created_at desc limit 2;"
```

## Screenshot

`issue-32-terminal-at-cap.png`

> **Caption.** Run `4567f8e7` in `/admin/production-engineer` after exhausting its attempt
> budget, showing `failed · 2/3 stages · concurrency 1 · repair cap 2` and
> `verify · failed · attempt 2/2 · codex/ui-proof-standin`. The terminal state pictured is
> the one written by `factory_workflow_events` rows
> `c75f1a27-9b77-446e-9b2c-efdee8f9e409` (stage `running → failed`, `attempts: 2`) and
> `2fc45472-5b49-45cc-8bcc-fda2fa71a2e6` (run `running → failed`), both at
> **`2026-09-04 21:11:02.399134+00`**. The card also shows
> `Durable transition timeline (26)`, matching the row count for this run.

## Why the attempts were genuinely spent

The stage failed on a **required runtime check the runtime spawned**, not on an
authentication error and not on an objective written to force failure. The visible error:

```
Required runtime check observable-change failed (1):
  error: Observable path audit/evidence/issue-32-terminal-probe.txt was not changed by this run.
  at .../scripts/verify-observable-change.ts:32:13
```

The `verify` stage's own objective, visible in the screenshot, records the guarantee that
makes this meaningful:

> "The runtime validates the expected artifact independently; its expected bytes and
> digest are intentionally withheld from the model prompt."

So the harness was never told what to produce, produced nothing, and a real script the
runtime ran reported the absence with a non-zero exit. `diagnose` and `repair` both
`succeeded` at `attempt 1/2` first, so the failure is specific to the terminal stage
rather than a run that could not start.

This is the distinction that made the earlier attempt at this criterion unusable: that run
reached its cap because a benchmark model routed to the real Codex CLI and returned
HTTP 400 on an unauthenticated account. An infrastructure error is not the workflow
exhausting its budget.

## Harness disclosure

The route was served by a deterministic stand-in (`codex/ui-proof-standin`, visible on
every stage in the screenshot) so stages would run without a live model. Its verdict is
recorded honestly in the evidence bundle: *"Stand-in harness: inspected the stage
objective and produced no source change."*

The stand-in decides only whether a stage produces output. It has no access to the attempt
counter, the terminal-state reconciliation, the observable-change check, or
`factory_workflow_events`. Worker and reviewer session ids on each stage are distinct
(`f465621b…` / `5e182338…` on diagnose, `9d763d64…` / `9e8d91ca…` on repair), so the
reviewer path ran as a separate session as designed.

A benchmark row `codex / ui-proof-standin` was inserted at quality 0.95 so the router
would select it. Existing rows were left in place: `chooseModel` throws when no candidate
is eligible, so deleting them prevents launching at all (filed as #108).

## Companion evidence

`issue-32-pause-refund.md` covers the other half of issue #32: an operator pause at the
attempt ceiling refunds the attempt (3 → 2) rather than burning it. Together the two
documents cover the issue's failure scenario in both directions — a pause does not consume
an attempt, and genuine exhaustion reaches a terminal state instead of wedging in
`running` while holding a concurrency slot.
