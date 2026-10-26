#!/usr/bin/env bash
# One command for the whole local system:
#   1. create the k3d cluster (if it doesn't exist)
#   2. build our 5 images and load them into the cluster
#   3. helm upgrade --install with values-local.yaml
# Run with Git Bash on Windows:  & "C:\Program Files\Git\bin\bash.exe" scripts/local-up.sh
set -euo pipefail
command -v kubectl >/dev/null || { echo "kubectl not found (on Windows use Git Bash, not WSL)"; exit 1; }
for t in docker k3d helm; do command -v $t >/dev/null || { echo "$t not found on PATH"; exit 1; }; done
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

CLUSTER=woo
# Image tags must match charts/platform/values.yaml.
IMAGES=(
  "mcp-woocommerce:0.1.1=mcp-woocommerce"
  "mcp-notes:0.1.1=mcp-notes"
  "mcp-toolbox:0.1.1=mcp-toolbox"
  "mcp-gateway:0.3.0=gateway"
  "mcp-dashboard:0.1.0=dashboard"
)

echo "== 1. Cluster"
if k3d cluster list "$CLUSTER" >/dev/null 2>&1; then
  echo "  k3d cluster '$CLUSTER' exists"
else
  k3d cluster create --config k8s/k3d-cluster.yaml
fi
kubectl config use-context "k3d-$CLUSTER" >/dev/null

# Load images into the cluster from your Docker (pulling them there first if needed), and
# check they really arrived. The cluster's own downloads from Docker Hub can time out on a
# slow connection, and "k3d image import" occasionally fails silently; this handles both.
load_images() {
  for image in "$@"; do
    docker image inspect "$image" >/dev/null 2>&1 || docker pull -q "$image" >/dev/null || echo "  could not pull $image"
  done
  for attempt in 1 2 3; do
    k3d image import "$@" -c "$CLUSTER" >/dev/null 2>&1 || true
    missing=()
    present=$(docker exec "k3d-$CLUSTER-server-0" crictl images 2>/dev/null)
    for image in "$@"; do
      repo=${image%:*}; tag=${image##*:}
      echo "$present" | grep -qE "(^|/)$repo +$tag " || missing+=("$image")
    done
    [ ${#missing[@]} -eq 0 ] && return 0
    echo "  retrying import of: ${missing[*]}"; set -- "${missing[@]}"
  done
  echo "  WARNING: still missing after 3 attempts: ${missing[*]}"
}

echo "  loading k3s system images from your Docker ..."
sleep 10   # let k3s create its system pods so we know which images they use
SYSTEM=$(kubectl get pods -n kube-system -o jsonpath='{range .items[*]}{range .spec.containers[*]}{.image}{"\n"}{end}{end}' | sort -u)
[ -n "$SYSTEM" ] && load_images $SYSTEM

echo "  waiting for Traefik (the ingress controller) ..."
until kubectl -n kube-system get deploy traefik >/dev/null 2>&1; do sleep 3; done
kubectl -n kube-system rollout status deploy/traefik --timeout=300s >/dev/null

echo "== 2. Images"
names=()
for entry in "${IMAGES[@]}"; do
  image=${entry%%=*}; dir=${entry#*=}
  docker build -q -t "$image" "$dir" >/dev/null && echo "  built $image"
  names+=("$image")
done
# Public images too: pulled once into your Docker and copied into the cluster. A fresh
# cluster downloading ~1 GB on a slow connection can exceed Kubernetes' 10-minute
# rollout deadline and make "helm install --wait" fail; importing avoids that.
PUBLIC=(mysql:8.4 wordpress:7.1-apache wordpress:cli-2.12-php8.3 postgres:17-alpine curlimages/curl:8.11.1)
load_images "${names[@]}" "${PUBLIC[@]}" && echo "  imported into k3d"

echo "== 3. Helm"
helm upgrade --install platform charts/platform -f charts/platform/values-local.yaml --timeout 15m --wait
