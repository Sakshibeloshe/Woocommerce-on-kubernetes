#!/usr/bin/env bash
# Deploys everything (store, MCP servers, gateway) onto the k3d cluster "woo", in order.
# Safe to re-run. Run from anywhere: bash k8s/deploy.sh
set -euo pipefail
# kubectl must be on PATH. On Windows, PowerShell's "bash" is WSL (Linux), which has
# no kubectl and doesn't know the k3d cluster: use Git Bash instead.
command -v kubectl >/dev/null || {
  echo "kubectl not found. On Windows, run this script with Git Bash:"
  echo "  & 'C:\Program Files\Git\bin\bash.exe' $0"
  exit 1
}
export MSYS_NO_PATHCONV=1                      # Git Bash on Windows: don't rewrite /paths
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Image tags: bump one when its code changes, so Kubernetes rolls out the new version.
declare -A IMAGES=(
  [mcp-woocommerce]="mcp-woocommerce:0.1.1"
  [mcp-notes]="mcp-notes:0.1.1"
  [mcp-toolbox]="mcp-toolbox:0.1.1"
  [gateway]="mcp-gateway:0.2.2"
  [dashboard]="mcp-dashboard:0.1.0"
)

echo "== 1. Build our images and load them into the cluster (it can't see your local Docker images)"
for dir in "${!IMAGES[@]}"; do
  docker build -q -t "${IMAGES[$dir]}" "$dir" >/dev/null && echo "  built ${IMAGES[$dir]}"
done
k3d image import "${IMAGES[@]}" -c woo >/dev/null 2>&1 && echo "  imported"

echo "== 2. Namespaces + Secrets (random values, created once)"
bash k8s/create-secrets.sh | sed 's/^/  /'

echo "== 3. Store: config, MySQL, WordPress, Ingress"
kubectl apply -f k8s/store/10-config.yaml -f k8s/store/20-mysql.yaml -f k8s/store/30-wordpress.yaml

echo "== 4. Store setup Job (re-run from scratch each time; it's idempotent)"
kubectl -n store create configmap store-setup-scripts --from-file=k8s/store/setup/ --dry-run=client -o yaml | kubectl apply -f -
kubectl -n store delete job store-setup --ignore-not-found
kubectl apply -f k8s/store/40-setup-job.yaml
kubectl -n store wait --for=condition=complete job/store-setup --timeout=900s

echo "== 5. MCP servers + NetworkPolicies"
kubectl apply -f k8s/store/50-mcp-woocommerce.yaml -f k8s/store/60-network-policies.yaml -f k8s/mcp-servers/
kubectl -n store rollout status deploy/mcp-woocommerce --timeout=180s
kubectl -n mcp-servers rollout status deploy/mcp-notes --timeout=180s
kubectl -n mcp-servers rollout status deploy/mcp-toolbox --timeout=180s

echo "== 6. Gateway: Postgres, backend, Ingress"
kubectl apply -f k8s/gateway/
kubectl -n gateway rollout status statefulset/postgres --timeout=300s
kubectl -n gateway rollout status deploy/gateway --timeout=300s

echo
echo "Storefront:   http://store.localtest.me"
echo "MCP endpoint: http://dashboard.localtest.me/mcp"
echo "wp-admin password:      kubectl -n store get secret wordpress-admin -o jsonpath='{.data.password}' | base64 -d"
echo "Gateway admin password: kubectl -n gateway get secret gateway-secrets -o jsonpath='{.data.admin-password}' | base64 -d"
