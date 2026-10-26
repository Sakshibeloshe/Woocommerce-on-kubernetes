#!/usr/bin/env bash
# Create and mark an isolated namespace for a store before installing its Helm release.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: bash scripts/prepare-store-namespace.sh <store-namespace>" >&2
  exit 2
fi
NAMESPACE=$1
if [[ ! "$NAMESPACE" =~ ^store-[a-z][a-z0-9-]*-[a-f0-9]{8}$ ]]; then
  echo "Refusing unexpected namespace name: $NAMESPACE" >&2
  exit 2
fi

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
kubectl label namespace "$NAMESPACE" platform.example/store=true --overwrite
echo "Prepared $NAMESPACE. Next run scripts/provision-store.sh with the store's hostname and title."
