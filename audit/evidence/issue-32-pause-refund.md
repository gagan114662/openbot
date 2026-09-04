# Issue #32 — an operator pause through the admin page refunds the attempt

Date: 2026-09-04. Run `574f2691-44c9-46a7-9cb5-7c2b104ed889`, `repair cap 3`.

## What this proves, and what it does not

Issue #32's failure scenario is that operator pause/resume consumes attempts until a
run wedges in `running` forever holding a concurrency slot. This document is the
**headed-UI evidence for the pause half of that scenario**: a person clicked **Pause**
in `/admin/production-engineer` while a stage was at the attempt ceiling, and the
attempt was refunded rather than burned.

It does **not** satisfy criterion 4, which asks for a run driven to its cap and shown
in a *terminal* state. This run is `paused`, not terminal, and criterion 4 remains
open. It is filed because the pause-refund path is the defect the issue actually
describes, and no prior evidence exercised it.

## The refund, in the system of record

`factory_workflow_events` rows for the pause, in order:

| Event id | Entity | Transition | `attempts` | `lastError` | Timestamp (UTC) |
| --- | --- | --- | --- | --- | --- |
| `a0fb0268-139d-4ddf-a13b-65936167cfd6` | run | `running → pausing` | — | — | `2026-09-04 20:27:35.230808+00` |
| `c3f1566c-3212-4a71-b97d-bde692982d76` | stage | `running → pending` | **2** | `Paused by an operator while running.` | `2026-09-04 20:27:35.655160+00` |
| `7f696656-bfc3-4a8f-be5e-701393ea39f8` | run | `pausing → paused` | — | — | `2026-09-04 20:27:36.674944+00` |

The stage entered that sequence at `attempts: 3` (set at `20:22:22.430466+00`, event
`4a3fa3bb-11e1-4ad6-9c25-088ec93563e1`). The middle row records it leaving at
`attempts: 2`. **3 → 2 is the refund**, written in the same transaction that returned
the stage to `pending`.

The operator control is separately audited:

| Audit row | Event type | Action | From → To | Timestamp (UTC) |
| --- | --- | --- | --- | --- |
| `45329830-2270-485c-9ad5-27f721a2d23b` | `workflow.control_applied` | `pause` | `running → pausing` | `2026-09-04 20:27:35.230808+00` |

Anyone with the repo `.env` can re-read all of it:

```sh
docker exec openbot-postgres-1 psql -U openbot -d openbot -c \
"select id, entity, from_status, to_status, detail->>'attempts' attempts,
        detail->>'lastError' last_error, created_at
   from factory_workflow_events
  where run_id = '574f2691-44c9-46a7-9cb5-7c2b104ed889'
  order by created_at;"
```

## Screenshot

`issue-32-pause-refund.png`

> **Caption.** Run `574f2691` in `/admin/production-engineer` after an operator clicked
> **Pause**, showing `paused · 0/3 stages · concurrency 1 · repair cap 3` and
> `diagnose · pending · attempt 2/3 · codex/ui-proof-standin`. The stage held
> `attempt 3/3` immediately before the pause. The state pictured is the one written by
> `factory_workflow_events` row `c3f1566c-3212-4a71-b97d-bde692982d76` at
> **`2026-09-04 20:27:35.655160+00`**, bracketed by run transitions
> `a0fb0268-139d-4ddf-a13b-65936167cfd6` at **`20:27:35.230808+00`** and
> `7f696656-bfc3-4a8f-be5e-701393ea39f8` at **`20:27:36.674944+00`**. The card also
> shows `Durable transition timeline (13)`, matching the 13 rows the query returns.

## Where the earlier attempts came from — disclosed

The stage was at `3/3` before the pause, and none of that came from pausing. The full
timeline shows each increment and its cause:

| Timestamp (UTC) | Transition | `attempts` | Cause |
| --- | --- | --- | --- |
| `20:10:21.162137` | stage `pending → running` | 1 | first start |
| `20:12:21.208569` | stage `running → pending` | 1 | `Worker lease expired before a result was committed.` |
| `20:12:21.266123` | stage `pending → running` | 2 | restart after lease loss |
| `20:22:21.293945` | stage `running → pending` | 2 | `Managed stage exceeded its 600000 ms execution` |
| `20:22:22.430466` | stage `pending → running` | 3 | restart after deadline |
| `20:27:35.655160` | stage `running → pending` | **2** | `Paused by an operator while running.` |

Both increments came from the **crash/deadline path**, which deliberately does not
refund — the runtime comment states that repeated crashes must still reach the
configured terminal stop. The lease expiry at `20:12` was caused by restarting the
server during setup. The deadline at `20:22` was caused by the stand-in harness holding
longer than the stage's 600000 ms execution budget.

That contrast is the point of the issue: **a crash burns an attempt, an operator pause
does not.** This run exercises both paths and the counter behaves differently in each.

## Harness disclosure

The route was served by a deterministic stand-in (`codex/ui-proof-standin`, visible in
the screenshot) rather than a live model, so the stage could be held in `running` long
enough for a person to click Pause. The stand-in only decides *whether a stage produces
output*; it has no access to the attempt counter, the pause path, or
`factory_workflow_events`. The refund under test is runtime behaviour and is unchanged
by which harness produced the stage.

A benchmark row `codex / ui-proof-standin` was inserted at quality 0.95 so the router
would select it. Existing benchmark rows were left in place: `chooseModel` throws when
no candidate is eligible, so deleting them would prevent launching a run at all.

## Corroboration outside the UI

The same behaviour is asserted by named tests on `f845bf6`, in
`server/tests/workflow-runtime.integration.test.ts`:

- `pausing and resuming five times on a one attempt run still lets the stage complete`
- `a SIGKILLed worker on a one attempt run reaches a terminal state within two worker ticks`

Mutation checks: removing the `greatest(attempts - 1, 0)` refund in `interruptStage`
fails the first with `attempts: 1` where `0` is expected; disabling the attempt-ceiling
check in `claim` fails the second with `status: "pending"` at tick 2.

## Still open for #32

- Criterion 4's terminal-state screenshot: a run driven to its cap and shown `failed`,
  captioned with the last two transition timestamps.
- The atomicity fault injection recorded as MISSING on the issue.
