# Helm charts

One app chart, backed by the [bjw-s
common](https://github.com/bjw-s-labs/helm-charts/tree/main/charts/library/common)
library scaffold:

| Chart | Workload |
|---|---|
| `pyrce-nakama/` | Nakama Deployment, Service (api/rt/console), cookie-affinity Ingress |

The static client bundle ships to a CDN, not to Kubernetes — there's
no client chart. The Agones GameServer fleet for the realtime gameplay
tier lives at `../k8s/agones/`; it isn't a Helm chart since Agones
already ships a CRD-based fleet model.

## Render / install

```bash
helm dependency update infra/helm/pyrce-nakama
helm template pyrce-nakama infra/helm/pyrce-nakama

# install once the image is pushed to ghcr.io/kanya-approve/pyrce-nakama
helm upgrade --install pyrce-nakama infra/helm/pyrce-nakama -n pyrce
```

Override any value via `--set` or `--values values.<env>.yaml`. The
`values.yaml` file is commented per-key.
