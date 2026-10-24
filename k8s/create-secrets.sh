#!/usr/bin/env bash
# Creates every Secret the cluster needs, filled with random values.
# Nothing secret is stored in git: this script generates values at deploy time.
#
# A Secret is only created if it does NOT exist yet. That matters: MySQL reads its
# password only the first time it initialises its volume. Regenerating the password
# later would lock WordPress out of its own database.
#
# Run: bash k8s/create-secrets.sh
set -euo pipefail
# kubectl must be on PATH. On Windows, PowerShell's "bash" is WSL (Linux), which has
# no kubectl and doesn't know the k3d cluster: use Git Bash instead.
command -v kubectl >/dev/null || {
  echo "kubectl not found. On Windows, run this script with Git Bash:"
  echo "  & 'C:\Program Files\Git\bin\bash.exe' $0"
  exit 1
}
cd "$(dirname "$0")"

rand() { openssl rand -hex "${1:-16}"; }   # 16 bytes -> 32 hex characters

ensure_secret() {
  local ns=$1 name=$2; shift 2
  if kubectl -n "$ns" get secret "$name" >/dev/null 2>&1; then
    echo "  $ns/$name already exists (kept)"
  else
    kubectl -n "$ns" create secret generic "$name" "$@" >/dev/null
    echo "  $ns/$name created"
  fi
}

kubectl apply -f 00-namespaces.yaml >/dev/null

echo "Secrets:"
# MySQL: root password + password for the "wordpress" database user
ensure_secret store mysql-credentials \
  --from-literal=root-password="$(rand)" \
  --from-literal=password="$(rand)"

# WordPress admin login (for wp-admin)
ensure_secret store wordpress-admin \
  --from-literal=username=admin \
  --from-literal=password="$(rand 12)" \
  --from-literal=email=admin@store.localtest.me

# WooCommerce REST API key. We generate it HERE; the setup Job registers it inside
# WooCommerce, and the MCP server reads the same Secret. Same format WooCommerce uses.
ensure_secret store woocommerce-api \
  --from-literal=consumer-key="ck_$(rand 20)" \
  --from-literal=consumer-secret="cs_$(rand 20)"

# Bearer token the notes MCP server requires (the gateway will hold a copy)
ensure_secret mcp-servers notes-auth \
  --from-literal=token="$(rand 24)"

# ---- gateway ----
ensure_secret gateway gateway-db \
  --from-literal=password="$(rand)"

# session-secret signs dashboard login cookies; encryption-key (32 bytes) encrypts
# upstream credentials stored in Postgres; admin-* is the first dashboard admin.
ensure_secret gateway gateway-secrets \
  --from-literal=session-secret="$(rand 32)" \
  --from-literal=encryption-key="$(rand 32)" \
  --from-literal=admin-email=admin@example.com \
  --from-literal=admin-password="$(rand 12)"

# The gateway needs its own copy of the notes token to register that server on first
# start (a pod can only read Secrets from its own namespace).
NOTES_TOKEN=$(kubectl -n mcp-servers get secret notes-auth -o jsonpath='{.data.token}' | base64 -d)
ensure_secret gateway gateway-upstream-credentials \
  --from-literal=notes-token="$NOTES_TOKEN"

echo
echo "Read a value (example):"
echo "  kubectl -n store get secret wordpress-admin -o jsonpath='{.data.password}' | base64 -d"
