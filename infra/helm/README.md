# Helm charts

`pyrce-nakama/` is the only chart. It provisions:

- The Nakama Deployment, Service (api/rt/console), cookie-affinity Ingress.
  One Nakama replica hosts many concurrent matches — scale replicas only
  when matches/pod gets uncomfortable.
- A `Secret` with `session_encryption_key`, `session_refresh_encryption_key`,
  `runtime_http_key`, `console_password` — auto-generated on first install
  via `randAlphaNum`, preserved on upgrades via `lookup`. Rotate by deleting
  `pyrce-nakama-secrets` and re-running `helm upgrade`.
- A [CloudNativePG](https://cloudnative-pg.io/) `Cluster` (`pyrce-pg`)
  for the Nakama database — 1 instance by default. Bump
  `postgres.instances` to 3 for HA (CNPG handles sync replication +
  failover automatically).
- An Agones `Fleet` + buffer `FleetAutoscaler` for the dedicated
  game-server pool. Nakama allocates a Ready pod from the fleet per
  match. Tune `agones.fleet.replicas` and `agones.autoscaler.{buffer,min,max}`.

The static client bundle ships to a CDN, not Kubernetes — no client chart.
A reference allocation request body lives at
`../k8s/agones-allocation-example/` (illustrative — never `kubectl apply`'d).

## Prereqs

The CNPG and Agones operators must be installed cluster-wide first:

```bash
# CloudNativePG operator
helm repo add cnpg https://cloudnative-pg.github.io/charts
helm upgrade --install cnpg cnpg/cloudnative-pg -n cnpg-system --create-namespace

# Agones operator
kubectl apply -f https://raw.githubusercontent.com/googleforgames/agones/release-1.57.0/install/yaml/install.yaml
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
`agones.fleet.image.tag`, `postgres.instances` (1→3 for HA).
