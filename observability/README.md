# Codex adapter observability

Scrape the adapter's loopback-only `/metrics` endpoint using the deployment's
`MANAGED_AGENT_TOKEN` in the `x-openbot-agent-token` header. Import
`grafana/openbot-codex.json` and load `prometheus/openbot-codex.rules.yml` into the corresponding
Prometheus rule files.

The dashboard separates every deployment using `DEPLOYMENT_ID`. Because a ChatGPT/Codex
subscription does not expose billable token or dollar usage to this adapter, the cost boundary is
the persistent daily run budget and concurrency limit. Do not label that proxy as dollar cost.

Default SLO alerts are p95 latency above 60 seconds, errors above 5%, budget above 90%, and sustained
concurrency saturation. Tune those values to an approved tenant SLO before production exposure.
