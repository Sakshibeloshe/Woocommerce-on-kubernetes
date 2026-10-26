#!/usr/bin/env bash
# Delete all store resources, PVCs, Secrets and the namespace as a unit.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: bash scripts/delete-store-namespace.sh <store-namespace>" >&2
  exit 2
fi
NAMESPACE=$1
if [[ ! "$NAMESPACE" =~ ^store-[a-z][a-z0-9-]*-[a-f0-9]{8}$ ]]; then
  echo "Refusing unexpected namespace name: $NAMESPACE" >&2
  exit 2
fi
kubectl delete namespace "$NAMESPACE" --wait=true --timeout=5m --ignore-not-found
echo "Deleted namespace $NAMESPACE. Return to Dashboard > Stores and confirm cleanup."
