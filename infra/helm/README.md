# Helm charts

Two app charts, both backed by the [bjw-s
common](https://github.com/bjw-s-labs/helm-charts/tree/main/charts/library/common)
library scaffold:

| Chart | Workload |
|---|---|
| `pyrce-nakama/` | Nakama Deployment, Service (api/rt/console), cookie-affinity Ingress |
| `pyrce-client/` | nginx Deployment serving the Vite bundle, Ingress |

The Agones GameServer fleet for the realtime gameplay tier lives at
`../k8s/agones/`; it isn't a Helm chart since Agones already ships
a CRD-based fleet model.

## Render / install

```bash
helm dependency update infra/helm/pyrce-nakama
helm dependency update infra/helm/pyrce-client

helm template pyrce-nakama infra/helm/pyrce-nakama
helm template pyrce-client infra/helm/pyrce-client

# install once images are pushed to ghcr.io/kanya-approve/pyrce-{nakama,client}
helm upgrade --install pyrce-nakama infra/helm/pyrce-nakama -n pyrce
helm upgrade --install pyrce-client infra/helm/pyrce-client -n pyrce
```

Override any value via `--set` or `--values values.<env>.yaml`. The
`values.yaml` files are commented per-key.
