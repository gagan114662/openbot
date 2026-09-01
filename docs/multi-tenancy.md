# Multi-tenancy

OpenBot uses **deployment-per-tenant isolation**. A tenant gets its own API release, database,
credential vault, audit trail, worker, computer storage, encryption key, identity-provider policy,
and network boundary. This is intentionally not shared-schema multi-tenancy: almost every product
table predates a tenant key, and adding a tenant selector only to HTTP routes would leave background
workers, connector callbacks, audit queries, credentials, and computer volumes capable of crossing
the boundary.

## Kubernetes production topology

Install one Helm release in one namespace per tenant. Give every release:

- a distinct managed PostgreSQL database and database credential;
- a distinct credential-vault encryption key;
- a tenant-specific hostname and identity-provider policy;
- tenant-specific secrets and external-secret path;
- a tenant package containing only that tenant's Bots, channels, skills, and branding.

`DEPLOYMENT_ID` defaults to `<namespace>/<release>` in the chart. It scopes thread identities when
several tenants share one CopilotKit Intelligence project. Set `config.deploymentId` only when a
stable externally assigned tenant identifier is required, and never change it after the tenant has
created threads.

Example release layout:

```sh
helm upgrade --install acme charts/openbot \
  --namespace openbot-acme --create-namespace \
  -f tenants/acme.values.yaml

helm upgrade --install globex charts/openbot \
  --namespace openbot-globex --create-namespace \
  -f tenants/globex.values.yaml
```

Route `acme.example.com` and `globex.example.com` to their respective releases. Do not point both
releases at the same database or Kubernetes Secret. Sharing an Intelligence project is supported;
sharing the OpenBot product database is not.

## Local isolated stacks

For local testing, give each stack a unique `COMPOSE_PROJECT_NAME`, ports, database URL, tenant
package directory, and secrets. `scripts/start.sh` derives both `DEPLOYMENT_ID` and
`COMPUTER_NAMESPACE` from the Compose project unless explicitly configured. Compose then gives the
stack separate PostgreSQL and browser-profile volumes.

Running several tenants from one source checkout is not supported by the Vite development launcher:
the generated application configuration is a build artifact. Use separate worktrees/checkouts, or
build and deploy one image/release per tenant.

## Isolation invariants

The following are release boundaries and must never be reused between tenants:

1. PostgreSQL database (a separate database is sufficient; a separate cluster is stronger).
2. `KEY_ENCRYPTION_KEY`, authentication secret, tool tokens, and connector credentials.
3. Kubernetes namespace/release or local `COMPOSE_PROJECT_NAME`.
4. Public hostname, OAuth redirect URIs, and allowed identity-provider tenant/domain.
5. Computer namespace, workspace volumes, browser profiles, and egress policy.
6. Tenant package and administrator allow-list.

Backups, restores, exports, audit retention, deletion, and incident response must operate on exactly
one tenant boundary. Cross-tenant analytics should consume redacted exports rather than query live
tenant databases directly.

## Why there is no tenant switcher

A tenant switcher requires a trusted control plane that maps a signed-in person to allowed tenant
deployments and exchanges a short-lived assertion with the selected release. That control plane is
not part of this repository. Adding a tenant dropdown to the client without that boundary would be
security theatre: a caller could simply send another tenant id. Put tenant selection in the identity
gateway or a separately reviewed control plane, then route to the isolated tenant release.
