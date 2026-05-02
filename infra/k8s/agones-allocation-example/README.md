# Agones allocation example

`gameserverallocation.yaml` is **illustrative only** — do NOT
`kubectl apply` it directly. It documents the request body that Nakama's
`allocateGameServer` RPC POSTs to the in-cluster `agones-allocator`
service when a match needs a dedicated game-server pod.

The Fleet + FleetAutoscaler that this allocation targets are defined in
the `pyrce-nakama` Helm chart (`infra/helm/pyrce-nakama/templates/agones-*.yaml`),
not here.

The Nakama pod needs the allocator's TLS client cert / key mounted as a
secret; see `packages/server/src/rpc/allocateGameServer.ts` for the env
vars (`AGONES_ALLOCATOR_URL`, `AGONES_ALLOCATOR_CLIENT_CERT`,
`AGONES_ALLOCATOR_CLIENT_KEY`, `AGONES_ALLOCATOR_CA_CERT`).
