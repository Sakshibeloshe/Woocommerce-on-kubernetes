# Plain Kubernetes manifests (learning path)

These are the hand-written manifests from building the platform step by step
(store, MCP servers, gateway), applied with `kubectl apply` via `deploy.sh`.

**The supported install is the Helm chart in [`charts/platform`](../charts/platform)**
(`scripts/local-up.sh` locally, [`docs/vps.md`](../docs/vps.md) on a VPS). The chart
contains the same resources, with environment differences moved into values, plus
default-deny NetworkPolicies and the hardening from phase 16.

Still used by the chart workflow:
- `k3d-cluster.yaml`: the local cluster definition (`scripts/local-up.sh` uses it).
- `create-secrets.sh`: creates the platform Secrets with kubectl, for installs with
  `secrets.generate=false` (production).
- `test-gateway.sh`: end-to-end gateway checks; works against either install.
