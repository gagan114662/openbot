# Production-readiness and battle-test record

Last verified: 2026-09-01.

## Seven-layer model

The original checklist named seven layers but described six. This project treats the missing seventh
as **governance and continuous improvement**: versioned policy, evaluation-gated releases, incident
review, rollback, and accountable ownership.

| Layer | Current implementation | Remaining production gate |
| --- | --- | --- |
| Experience and trigger | authenticated users, channels, direct chat, routines | configure a real identity provider before network exposure |
| Orchestration and state | durable Intelligence threads, bounded Codex turns, routine leases and failure caps | task-specific definitions of done and escalation policy |
| Tools and deterministic logic | governed computer, shell, file and MCP calls; integer-money, source-grounding, and risk verifiers | add verifiers when a tenant introduces another deterministic domain rule |
| Trusted context | skills, least-privilege connector grants, and opt-in human-approved organizational memory | keep source freshness, schemas, and exception catalogues tenant-owned |
| Trust and control | CEL boundaries, audit trail, content scanning, deterministic reward gates, and a versioned fintech golden set | organization-specific human-judge thresholds |
| Runtime and operations | per-Bot computers, health checks, model adapter seam, routine worker, deployment-per-tenant isolation, backup/restore and replica drills, tenant budgets, Prometheus alerts, and Grafana dashboard | connect alerts to the deployment's paging destination |
| Governance and improvement | versioned verifier results and training eligibility gates | release approval, incident workflow, dataset lineage, rollback automation |

## Verifiable-reward posture

`shared/verifiable-reward.ts` defines versioned episodes, independent verifier evidence, reward
vectors, and hard training-eligibility gates. Critical safety failures, policy refusals, partial
success, malformed measurements, and missing state hashes receive zero training reward. Production
traffic is not automatically training data.

This is the safe substrate for best-of-N selection and rejection sampling. Weight updates still
belong in an external training system and must pass held-out evaluation before deployment.

## Upstream open-issue inventory

Open upstream issues observed on 2026-09-01:

- [#314](https://github.com/CopilotKit/OpenBot/issues/314): stale channel busy indicator. Fixed in this fork by coupling busy transitions to the async turn rather than component lifetime.
- [#295](https://github.com/CopilotKit/OpenBot/issues/295): subscription-backed ACP harnesses. This fork supplies a Codex app-server adapter with dynamic OpenBot tools, read-only native capabilities, content checks, a tool-call cap, and a turn timeout. It remains a local-only integration.
- [#280](https://github.com/CopilotKit/OpenBot/issues/280): opt-in reviewed long-term memory. Implemented as an optional `memory.yaml`; only entries with reviewer, timestamp, source, and approved status enter a Bot role.
- [#219](https://github.com/CopilotKit/OpenBot/issues/219): built-in acceptance test and Hermes bridge. The live deployment smoke test and Codex adapter cover the acceptance-test/protocol pattern; no Hermes bridge is included.
- [#193](https://github.com/CopilotKit/OpenBot/issues/193): routines. The current repository already contains the worker, leases, renewal, failure caps, disabling, and delivery recording described by the issue; load and cold-resume drills remain deployment work.
- [#86](https://github.com/CopilotKit/OpenBot/issues/86): content governance. This fork adds deterministic secret, SSN, valid payment-card, and prompt-injection scanning before the Codex adapter sends deployment tool arguments.
- [#2](https://github.com/CopilotKit/OpenBot/issues/2): dependency dashboard. Keep automated dependency PRs and pinned action digests in the normal release process.

## Battle tests run

- Full unit and integration suite: 2,169 passing, 23 intentionally skipped, 0 failing. Database
  integration tests ran against a dedicated migrated `openbot_test` database; running them against
  the live application database allowed the real handoff worker to consume test work and is not a
  valid test topology.
- Live stack smoke: runtime mode, license, Bot registry, deployment-scoped thread IDs, real Chromium
  navigation, screenshot, audit recording, CEL refusal, and refusal audit evidence.
- Subscription adapter: authenticated text streaming and dynamic tool calls.
- Adversarial tool probe: credential-shaped arguments are blocked by default. This deployment's
  explicit exception forwarded a fake credential only to an approved tool while category-only
  redaction kept the value out of the AG-UI stream. SSNs, payment cards, injection content, and
  unapproved tools remain blocked.
- Host-boundary probe: a direct request to read `/etc/hosts` was refused because no native
  file-reading capability was available.
- Encryption rotation: all 26 stored credentials were decrypted before the transaction, re-encrypted
  with a non-development 32-byte key, and verified with the new key.
- Golden set: all three versioned fintech tasks passed deterministic integer-money, retrieved-source,
  and risk-flag verifiers.
- Database recovery: a custom-format PostgreSQL backup was checksum-verified and restored into a
  disposable database (`users=1`, `credentials=26`, `audit_events=368`).
- Replica load: two independent server processes handled 200 requests at concurrency 20 with zero
  failures and 12.7 ms p95 on this host.
- Frontend bundles: the largest production JavaScript asset is 1,101 KiB against a 1,200 KiB budget,
  down from the original roughly 3,000 KiB entry bundle. CopilotKit React/runtime, AG-UI, and TanStack
  are separate cacheable chunks.
- Operations: the authenticated live metrics endpoint exports deployment-labelled budgets, errors,
  refusals, concurrency, and latency histogram series. The Grafana dashboard and Prometheus alerts
  cover budget exhaustion, p95 latency, error ratio, and concurrency saturation.
- Startup recovery: stopped OrbStack, occupied PostgreSQL port, current CopilotKit key naming,
  Docker workspace manifests, migrations, and host-process lifetime were exercised and corrected.

## Do not call this production-ready until

1. Single-user mode is disabled and a real identity provider is configured.
2. Tenant owners approve the golden-set and SLO thresholds for their production workload.
3. Prometheus/Grafana assets are connected to the production monitoring and paging systems.
4. Browser cold-start and routine recovery drills are repeated in the target production platform.
