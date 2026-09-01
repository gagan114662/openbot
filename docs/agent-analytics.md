# Agent Analytics

OpenBot's Agent Analytics is a tenant-local observability and product-analytics subsystem. Its parity contract is based on Amplitude's public [Agent Analytics](https://amplitude.com/agent-analytics) feature set, while preserving OpenBot capabilities Amplitude explicitly does not replace: offline evaluation, deployment, policy enforcement, and deterministic verification.

## Parity contract

| Capability             | OpenBot contract                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session explorer       | Search and filter sessions by agent, user, status, intent, topic, model, time, task success, technical failure, or tool failure.                                                                        |
| Trace detail           | Prompts, completions, retrievals, tool calls/results, product events, errors, token use, latency, cost, model, and prompt version form one ordered timeline.                                            |
| Product outcomes       | Agent traces join to conversion, retention, engagement, revenue, and arbitrary product events through `userId` and `sessionId`.                                                                         |
| Standard signals       | Task completion, helpfulness, intent, safety, friction, negative feedback, data quality, tool quality, grounding, failure reasons, memory recall, and action offers.                                    |
| Custom evaluation      | Versioned code and LLM-judge evaluators; binary, categorical, and numeric results; draft/active/archived lifecycle; calibration and scheduled runs; regression alerts.                                  |
| Topics                 | Sessions may be clustered and ranked by topic, with scorecards and failure rates per topic.                                                                                                             |
| Human review           | Review queues, labels, error categories, notes, assignees, review progress, and immutable reviewer attribution.                                                                                         |
| Datasets               | Repeatable slices and golden/calibration sets selected by agent, model, product surface, user cohort, or query.                                                                                         |
| Product analytics      | Cohorts, funnels, paths, retention, conversion, revenue attribution, model comparisons, and quality-to-outcome correlation.                                                                             |
| Experiments and guides | Model/prompt variants are attached to every event; outcomes can select cohorts for targeted in-product guidance.                                                                                        |
| Replay                 | A replay id and deep link may be attached to every event and session.                                                                                                                                   |
| Export                 | Administrators can export a filtered session/event set as JSONL without bypassing the selected privacy mode.                                                                                            |
| Privacy                | `full` stores redacted content, `metadata_only` stores no raw content, and `customer_enriched` stores customer-authored summaries/labels but no raw conversation. Redaction happens before persistence. |
| Access control         | Viewing, managing inactive evals, and activating evals are separate permissions. Deployment administrators receive all three by default.                                                                |
| Instrumentation        | Native OpenBot events and OpenTelemetry GenAI-shaped spans use one idempotent ingestion contract. Provider/framework names remain properties, not hard-coded branches.                                  |

## Security invariants

- Analytics never reads secrets from the credential vault or weakens the append-only audit trail.
- Prompt and result content is redacted before it reaches PostgreSQL. Metadata-only and customer-enriched sources reject raw content rather than storing and hiding it later.
- Every browser route requires a signed-in actor. Administrative analytics reads require an explicit analytics permission or deployment administrator role.
- Actor, user, agent, session, and replay identifiers are correlation fields; authorization is still decided by the owning OpenBot deployment and its membership rules.
- Ingestion is idempotent by `(source, idempotencyKey)` and append-oriented. Derived evaluation, topic, dataset, and review records never rewrite raw trace evidence.
