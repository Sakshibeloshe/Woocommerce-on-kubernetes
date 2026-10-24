#!/usr/bin/env bash
# Phase 16: every security control, demonstrated by a command that must FAIL.
#   bash scripts/test-hardening.sh          (Git Bash on Windows)
# Note: the rate-limit checks at the end block further failed attempts from your IP
# for a minute (API keys) / 15 minutes (logins for the fake email used here).
set -uo pipefail
command -v kubectl >/dev/null || { echo "kubectl not found (on Windows use Git Bash, not WSL)"; exit 1; }
export MSYS_NO_PATHCONV=1
BASE=http://dashboard.localtest.me
WORK=$(cd "$(mktemp -d)" && (pwd -W 2>/dev/null || pwd)); JAR=$WORK/admin.cookies
ok=0; bad=0
expect_fail() { # description, command...  (passes when the command FAILS)
  local d=$1; shift
  if out=$("$@" 2>&1); then echo "  FAIL  $d  (it succeeded: ${out:0:120})"; bad=$((bad+1));
  else echo "  PASS  $d  -> blocked: $(echo "$out" | tr '\n' ' ' | cut -c1-110)"; ok=$((ok+1)); fi
}
expect_ok() {
  local d=$1; shift
  if out=$("$@" 2>&1); then echo "  PASS  $d"; ok=$((ok+1)); else echo "  FAIL  $d: ${out:0:160}"; bad=$((bad+1)); fi
}
# Run a command in a throwaway pod (namespace, labels, shell command). The pod waits 8s
# first: k3s needs a moment to apply NetworkPolicies to a brand-new pod's IP.
in_pod() { kubectl -n "$1" run "hard-$RANDOM" --rm -i --restart=Never --quiet --labels="$2" \
  --image=curlimages/curl:8.11.1 --command -- sh -c "sleep 8; $3"; }

echo "== 1. NetworkPolicies (default deny + explicit allows)"
expect_fail "debug pod (default ns) -> WooCommerce MCP server" in_pod default app=debug "curl -sf -m 5 http://mcp-woocommerce.store.svc/healthz"
expect_fail "debug pod (default ns) -> MySQL"                  in_pod default app=debug "nc -z -w 5 mysql.store.svc 3306"
expect_fail "debug pod (default ns) -> gateway Postgres"       in_pod default app=debug "nc -z -w 5 postgres.gateway.svc 5432"
expect_fail "pod in store ns (not WordPress) -> MySQL"         in_pod store app=debug "nc -z -w 5 mysql.store.svc 3306"
expect_fail "pod in mcp-servers ns -> internet (egress denied)" in_pod mcp-servers app=debug "curl -sf -m 5 https://example.com"
GW=$(kubectl -n gateway get pod -l app=gateway -o jsonpath='{.items[0].metadata.name}')
gw_fetch() { kubectl -n gateway exec "$GW" -- node -e "fetch('$1',{signal:AbortSignal.timeout(5000)}).then(r=>{console.log('HTTP',r.status)}).catch(e=>{console.log(e.cause?.code||e.message);process.exit(1)})"; }
expect_fail "gateway pod -> cloud metadata 169.254.169.254"     gw_fetch http://169.254.169.254/latest/meta-data/
expect_fail "gateway pod -> WordPress directly (only MCP allowed)" gw_fetch http://wordpress.store.svc/
# Plain TCP connect (no TLS), so a failure means the network blocked it, not a certificate.
gw_tcp() { kubectl -n gateway exec "$GW" -- node -e "const s=require('net').connect($2,'$1');s.setTimeout(5000);s.on('connect',()=>{console.log('connected');process.exit(0)});s.on('timeout',()=>{console.log('timeout');process.exit(1)});s.on('error',e=>{console.log(e.code);process.exit(1)})"; }
expect_fail "gateway pod -> Kubernetes API (TCP 443)"          gw_tcp kubernetes.default.svc 443
expect_ok   "gateway pod -> WooCommerce MCP server (allowed)"   gw_fetch http://mcp-woocommerce.store.svc/healthz

echo "== 2. Containers: non-root, read-only root filesystem, no capabilities"
expect_ok   "gateway runs as uid 1000"   sh -c "kubectl -n gateway exec $GW -- id -u | grep -qx 1000"
expect_fail "write to gateway's root filesystem" kubectl -n gateway exec "$GW" -- touch /evil
DB=$(kubectl -n gateway exec postgres-0 -- id -u); MY=$(kubectl -n store exec mysql-0 -- id -u)
expect_ok   "postgres runs as uid 70 (got $DB), mysql as uid 999 (got $MY)" test "$DB" = 70 -a "$MY" = 999
expect_fail "become root inside the gateway (no setuid, no capabilities)" kubectl -n gateway exec "$GW" -- su -c id

echo "== 3. SSRF guard when an admin registers a server URL"
PW=$(kubectl -n gateway get secret gateway-secrets -o jsonpath='{.data.admin-password}' | base64 -d)
curl -s -c "$JAR" -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"admin@example.com\",\"password\":\"$PW\"}" >/dev/null
add_server() { # url -> fails if the gateway refuses it
  local r; r=$(curl -s -b "$JAR" -w "\n%{http_code}" -X POST "$BASE/api/servers" -H "Content-Type: application/json" \
    -d "{\"slug\":\"ssrf-$RANDOM\",\"name\":\"probe\",\"url\":\"$1\"}")
  local code=${r##*$'\n'}; local body=${r%$'\n'*}
  if [ "$code" = 201 ]; then  # clean up a server that was (wrongly or rightly) accepted
    id=$(echo "$body" | python -c "import sys,json;print(json.load(sys.stdin)['server']['id'])"); curl -s -b "$JAR" -X DELETE "$BASE/api/servers/$id" >/dev/null
    echo "accepted"; return 0; fi
  echo "$code $body"; return 1
}
expect_fail "cloud metadata http://169.254.169.254/"            add_server http://169.254.169.254/latest/meta-data/
expect_fail "gateway itself http://127.0.0.1:8080/mcp"           add_server http://127.0.0.1:8080/mcp
expect_fail "public name that resolves to 127.0.0.1 (localtest.me)" add_server http://localtest.me/mcp
expect_fail "gateway's own database postgres.gateway.svc"       add_server http://postgres.gateway.svc:5432/
expect_fail "Kubernetes API kubernetes.default.svc"             add_server https://kubernetes.default.svc/
expect_fail "private IP http://10.43.0.1/"                       add_server http://10.43.0.1/
expect_fail "non-HTTP scheme file:///etc/passwd"                 add_server file:///etc/passwd
expect_ok   "allowed: in-cluster Service in an allowed namespace" add_server http://mcp-toolbox.mcp-servers.svc/mcp

echo "== 4. Rate limits"
attempt_logins() { local code; for i in $(seq 1 12); do code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d '{"email":"nobody@example.com","password":"wrong-password"}'); done; echo "last=$code"; [ "$code" != 429 ]; }
expect_fail "12 wrong passwords in a row (limit: 10 per 15 min)" attempt_logins
attempt_keys() { local code; for i in $(seq 1 25); do code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/mcp" -H "Authorization: Bearer mcpgw_guess$i" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'); done; echo "last=$code"; [ "$code" != 429 ]; }
expect_fail "25 guessed API keys in a row (limit: 20 failures/min)" attempt_keys

rm -rf "$WORK"
echo; echo "$ok passed, $bad failed"
[ "$bad" = 0 ]
