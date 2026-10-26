#!/usr/bin/env bash
# Install one per-store Helm release using the current operator's kubeconfig.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "Usage: bash scripts/provision-store.sh <store-namespace> <store-hostname> <store-title>" >&2
  exit 2
fi
NAMESPACE=$1
HOSTNAME=$2
TITLE=$3
if [[ ! "$NAMESPACE" =~ ^store-[a-z][a-z0-9-]*-[a-f0-9]{8}$ ]]; then
  echo "Refusing unexpected namespace name: $NAMESPACE" >&2
  exit 2
fi
if [[ ! "$HOSTNAME" =~ ^store-[a-z][a-z0-9-]*\.[a-z0-9.-]+$ ]]; then
  echo "Refusing unexpected store hostname: $HOSTNAME" >&2
  exit 2
fi
kubectl get namespace "$NAMESPACE" -o jsonpath='{.metadata.labels.platform\.example/store}' | grep -qx true || {
  echo "Namespace is missing the platform.example/store=true label. Run prepare-store-namespace.sh first." >&2
  exit 1
}

suffix=${NAMESPACE##*-}
RELEASE="shop-${suffix}"
VALUES=$(mktemp)
trap 'rm -f "$VALUES"' EXIT
python3 - "$VALUES" "$NAMESPACE" "$HOSTNAME" "$TITLE" <<'PY'
import json, sys
path, namespace, hostname, title = sys.argv[1:]
with open(path, "w", encoding="utf-8") as f:
    json.dump({
        "namespaces": {"store": namespace, "create": False},
        "store": {"host": hostname, "title": title, "adminEmail": "admin@" + hostname},
    }, f)
PY

ARGS=()
if [ -n "${STORE_VALUES_FILE:-}" ]; then ARGS+=(--values "$STORE_VALUES_FILE"); fi
helm upgrade --install "$RELEASE" charts/store --namespace "$NAMESPACE" "${ARGS[@]}" \
  --values "$VALUES" --wait --wait-for-jobs --timeout 20m
echo "Store workload is ready. Return to Dashboard > Stores and click Register MCP."
