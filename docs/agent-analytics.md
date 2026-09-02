# Agent Analytics

OpenBot's Agent Analytics is a tenant-local observability and quality-operations subsystem. The table below is the shipped contract for the Amplitude-class surface implemented in OpenBot.

## Capability contract

| Capability             | OpenBot contract                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session explorer       | Shipped: search sessions by intent/summary/id and inspect model, outcome, latency, tool proof, human gates, privacy, tokens, and cost. Server filters also support agent, model, status, outcome, and time. |
| Trace detail           | Shipped: privacy-filtered events and spans, including tool identity, errors, token use, latency, cost, model, and prompt version. Raw prompts/tool arguments/results are excluded in metadata-only mode. |
| Standard signals       | Shipped: explicit task feedback, technical/tool failure, audit-backed tool and escalation verification, latency, human wait, token and cost signals.                                                     |
| Custom evaluation      | Shipped: versioned code and LLM-judge evaluators, built-in completion/helpfulness/friction signals, reusable runs, daily scheduling, calibration records, and score-drop regression flags.              |
| Topics                 | Shipped: deterministic clustering, human overrides, and per-topic task-success scorecards.                                                                                                               |
| Human review           | Shipped: sessions can be labelled, categorized, noted, and completed from the administrator explorer; debt violations enter the pending queue automatically.                                            |
| Datasets               | Shipped: named/golden datasets persist scoped session sets and can be used for repeatable evaluator runs.                                                                                                |
| Product analytics      | Shipped: tool/Bot usage, conversion outcome counts, revenue attribution, and session/event journeys share the same idempotent event contract and admin surface.                                         |
| Experiments and guides | Partially shipped: model/prompt and experiment identifiers may be ingested; cohort selection and targeted in-product guidance are not shipped.                                                            |
| Replay                 | A replay id and deep link may be attached to every event and session.                                                                                                                                   |
| Export                 | Administrators can export a filtered session/event set as JSONL without bypassing the selected privacy mode.                                                                                            |
| Privacy                | `full` stores redacted content, `metadata_only` stores no raw content, and `customer_enriched` stores customer-authored summaries/labels but no raw conversation. Redaction happens before persistence. |
| Access control         | Shipped analytics routes require authentication and administrator access for exploration. Fine-grained analytics permissions are represented in schema but not yet enforced as separate UI roles.       |
| Instrumentation        | Native OpenBot events and OpenTelemetry GenAI-shaped spans use one idempotent ingestion contract. Provider/framework names remain properties, not hard-coded branches.                                  |

## Reasoning-trace decision

OpenBot does not store hidden model reasoning or raw chain-of-thought. That material is neither a
stable API nor necessary to debug an agent, and collecting it would cross the metadata-only privacy
boundary. The supported trace is an opt-in, redacted sequence of externally observable spans:
prompt version and intent summary, model/tool names, timing, bounded status, verifier evidence hashes,
and audit event ids. Tool arguments/results and customer content remain excluded unless a deployment
selects the existing `full` privacy mode, and even then ingestion redaction still applies. A future
provider that exposes reasoning summaries may write only a bounded summary span after the same
redactor; raw private reasoning will not be added.

## Security invariants

- Analytics never reads secrets from the credential vault or weakens the append-only audit trail.
- Prompt and result content is redacted before it reaches PostgreSQL. Metadata-only and customer-enriched sources reject raw content rather than storing and hiding it later.
- Every browser route requires a signed-in actor. Administrative analytics reads require an explicit analytics permission or deployment administrator role.
- Actor, user, agent, session, and replay identifiers are correlation fields; authorization is still decided by the owning OpenBot deployment and its membership rules.
- Ingestion is idempotent by `(source, idempotencyKey)` and append-oriented. Derived evaluation, topic, dataset, and review records never rewrite raw trace evidence.
