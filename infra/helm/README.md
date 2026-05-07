# Helm charts

`pyrce-nakama/` is the only chart. It provisions:

- The Nakama Deployment, Service (api/rt/console), Ingress. **Pinned to a
  single replica.** Match state lives in-memory on the pod that owns each
  match, so a second replica silently breaks reconnect/chat routing — a
  reconnecting client can land on a pod that doesn't own its match with
  no error surfaced. Scale vertically (cpu/memory) only; horizontal scale
  is a follow-up project requiring sticky-session ingress + match-router
  redesign. The chart hard-fails at template time if anything other than
  `replicas: 1` is set on `controllers.nakama` — this is enforced, not a
  default. One Nakama pod hosts many concurrent matches.
- A `Secret` named `pyrce-nakama-secrets` with `session_encryption_key`,
  `session_refresh_encryption_key`, `runtime_http_key`, `console_password`
  — auto-generated on first install via `randAlphaNum`, preserved on
  upgrades via `lookup`. Rotate by deleting `pyrce-nakama-secrets` and
  re-running `helm upgrade`. To bring your own (External-Secrets, sealed-
  secrets, Vault, etc.), set `nakamaSecret.create: false` and apply a
  Secret named exactly `pyrce-nakama-secrets` containing the four keys
  above before installing.
- A [CloudNativePG](https://cloudnative-pg.io/) `Cluster` (`pyrce-pg`)
  for the Nakama database — 1 instance by default. Bump
  `postgres.instances` to 3 for HA (CNPG handles sync replication +
  failover automatically).

The static client bundle ships to a CDN, not Kubernetes — no client chart.

## Prereqs

The CNPG operator must be installed cluster-wide first:

```bash
helm repo add cnpg https://cloudnative-pg.github.io/charts
helm upgrade --install cnpg cnpg/cloudnative-pg -n cnpg-system --create-namespace
```

## Render / install

```bash
helm dependency update infra/helm/pyrce-nakama
helm template pyrce-nakama infra/helm/pyrce-nakama
helm upgrade --install pyrce-nakama infra/helm/pyrce-nakama -n pyrce --create-namespace
```

Override values via `--set` or `--values values.<env>.yaml`. Common
env-specific overrides: `controllers.nakama.containers.nakama.image.tag`,
`ingress.nakama.hosts[0].host`, `postgres.storage.storageClass`,
`postgres.instances` (1→3 for HA).
