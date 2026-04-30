# Agones manifests

Pyrce uses [Agones](https://agones.dev) to manage a fleet of dedicated
realtime game-server pods. Nakama runs separately (as a Deployment) and
acts as the matchmaker / identity backplane, calling the Agones
Allocator API to claim a Ready GameServer when a match is found.

## Apply order

```bash
kubectl create namespace pyrce

# 1. Agones core (https://agones.dev/site/docs/installation/)
kubectl apply -f https://raw.githubusercontent.com/googleforgames/agones/release-1.57.0/install/yaml/install.yaml

# 2. Pyrce GameServer fleet + autoscaler
kubectl apply -f infra/k8s/agones/fleet.yaml
kubectl apply -f infra/k8s/agones/fleetautoscaler.yaml

# 3. Verify
kubectl get gameservers -n pyrce
kubectl get fleet pyrce -n pyrce
```

## Allocator wiring

Nakama's `allocateGameServer` RPC POSTs a `GameServerAllocation` to the
in-cluster `agones-allocator` service. The request body is the
`spec` block of `gameserverallocation.yaml` (illustrative only — that
file is not applied directly).

The Nakama pod needs the allocator's TLS client cert / key mounted as a
secret; see `packages/server/src/rpc/allocateGameServer.ts` for the
exact env vars (`AGONES_ALLOCATOR_URL`, `AGONES_ALLOCATOR_CLIENT_CERT`,
`AGONES_ALLOCATOR_CLIENT_KEY`, `AGONES_ALLOCATOR_CA_CERT`).

## Image

The fleet template references `ghcr.io/kanya-approve/pyrce-game-server`.
Build + push from the repo root:

```bash
docker build -t ghcr.io/kanya-approve/pyrce-game-server:dev \
  -f packages/game-server/Dockerfile .
docker push ghcr.io/kanya-approve/pyrce-game-server:dev
```

Replace the image in `fleet.yaml` and re-apply.
