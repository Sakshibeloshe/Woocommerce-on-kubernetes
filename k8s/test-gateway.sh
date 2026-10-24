#!/usr/bin/env bash
# End-to-end checks for the gateway (Phase 12 "done when"), against the live cluster.
#   bash k8s/test-gateway.sh
# Creates a member "user B" (once), gives them an API key, and drives the gateway
# exactly like an MCP client would: through http://dashboard.localtest.me/mcp.
set -euo pipefail
# kubectl must be on PATH. On Windows, PowerShell's "bash" is WSL (Linux), which has
# no kubectl and doesn't know the k3d cluster: use Git Bash instead.
command -v kubectl >/dev/null || {
  echo "kubectl not found. On Windows, run this script with Git Bash:"
  echo "  & 'C:\Program Files\Git\bin\bash.exe' $0"
  exit 1
}
export MSYS_NO_PATHCONV=1
BASE=http://dashboard.localtest.me
# Temp dir for cookie jars. "pwd -W" gives a Windows path in Git Bash (Windows curl
# needs one); on Linux/macOS it fails and plain pwd is used.
WORK=$(cd "$(mktemp -d)" && (pwd -W 2>/dev/null || pwd))
ADMIN_JAR=$WORK/admin.cookies; B_JAR=$WORK/b.cookies
pass() { echo "  PASS  $*"; }
fail() { echo "  FAIL  $*"; exit 1; }
json() { python -c "import sys,json; d=json.load(sys.stdin); $1"; }

# Talk MCP (JSON-RPC over HTTP) to the gateway, as Inspector/Claude Code would.
mcp() { # key, method, params-json
  curl -s "$BASE/mcp" -H "Authorization: Bearer $1" -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":${3:-{\}}}" | sed -n 's/^data: //p; t; /^{/p'   # SSE "data:" line, or a plain JSON body
}
api() { # jar, method, path, [json]
  curl -s -b "$1" -c "$1" -X "$2" "$BASE$3" -H "Content-Type: application/json" ${4:+-d "$4"}
}
server_id() { api "$ADMIN_JAR" GET /api/servers | json "print(next(s['id'] for s in d['servers'] if s['slug']=='$1'))"; }
tool_names() { mcp "$1" tools/list | json "print(' '.join(sorted(t['name'] for t in d['result']['tools'])))"; }

echo "== 1. Admin login, registry, credentials hidden"
ADMIN_PW=$(kubectl -n gateway get secret gateway-secrets -o jsonpath='{.data.admin-password}' | base64 -d)
api "$ADMIN_JAR" POST /api/auth/login "{\"email\":\"admin@example.com\",\"password\":\"$ADMIN_PW\"}" | json "assert d['user']['role']=='admin'" && pass "admin logged in"
SERVERS=$(api "$ADMIN_JAR" GET /api/servers)
echo "$SERVERS" | json "[print(f\"        {s['slug']:8} {s['status']:12} {len(s['tools'])} tools  credential={s['credential']}\") for s in d['servers']]"
NOTES_TOKEN=$(kubectl -n mcp-servers get secret notes-auth -o jsonpath='{.data.token}' | base64 -d)
echo "$SERVERS" | grep -q "$NOTES_TOKEN" && fail "notes token leaked in API response" || pass "notes token never appears in the API response"

echo "== 2. Invite user B (member), accept invite, B creates their own API key"
B_EMAIL=user-b@example.com; B_PW="b-$(openssl rand -hex 8)"
INVITE=$(api "$ADMIN_JAR" POST /api/users "{\"email\":\"$B_EMAIL\",\"name\":\"User B\",\"role\":\"member\"}")
if echo "$INVITE" | grep -q invite_token; then
  TOKEN=$(echo "$INVITE" | json "print(d['invite_token'])")
  api "$B_JAR" POST /api/auth/accept-invite "{\"token\":\"$TOKEN\",\"password\":\"$B_PW\"}" | json "assert d['user']['role']=='member'" && pass "user B accepted invite (member)"
else
  # User B exists from an earlier run: reset by deleting and re-inviting.
  B_ID=$(api "$ADMIN_JAR" GET /api/users | json "print(next(u['id'] for u in d['users'] if u['email']=='$B_EMAIL'))")
  api "$ADMIN_JAR" DELETE "/api/users/$B_ID" >/dev/null
  TOKEN=$(api "$ADMIN_JAR" POST /api/users "{\"email\":\"$B_EMAIL\",\"name\":\"User B\",\"role\":\"member\"}" | json "print(d['invite_token'])")
  api "$B_JAR" POST /api/auth/accept-invite "{\"token\":\"$TOKEN\",\"password\":\"$B_PW\"}" >/dev/null && pass "user B re-invited and accepted"
fi
api "$B_JAR" GET /api/users | grep -q "Admins only" && pass "member cannot list users (403)"
NEWKEY=$(api "$B_JAR" POST /api/keys '{"name":"inspector"}')
B_KEY=$(echo "$NEWKEY" | json "print(d['key'])"); B_KEY_ID=$(echo "$NEWKEY" | json "print(d['id'])")
pass "user B created key $(echo "$NEWKEY" | json "print(d['prefix'])")... (full key shown once)"
api "$B_JAR" GET /api/keys | grep -q "$B_KEY" && fail "full key returned again" || pass "key list shows only the prefix"

echo "== 3. MCP with user B's key: tools from all three servers"
TOOLS=$(tool_names "$B_KEY"); echo "        $TOOLS"
for p in woo__ notes__ toolbox__; do echo "$TOOLS" | grep -q "$p" || fail "no $p tools"; done; pass "tools from woo, notes and toolbox"
mcp "$B_KEY" tools/call '{"name":"woo__list_orders","arguments":{}}' | json "r=d['result']; o=json.loads(r['content'][0]['text']); print(f\"        woo__list_orders -> {o['count']} order(s) today: \" + ', '.join(f\"#{x['id']} {x['total']} {x['currency']}\" for x in o['orders']))"
mcp "$B_KEY" tools/call '{"name":"toolbox__convert_currency","arguments":{"amount":499,"from":"INR","to":"USD"}}' | json "print('        toolbox__convert_currency ->', json.loads(d['result']['content'][0]['text'])['result'], 'USD')"
pass "calls routed to two different upstreams"

echo "== 4. Revoke user B's key: next call rejected"
api "$ADMIN_JAR" DELETE "/api/keys/$B_KEY_ID" | json "assert d['key']['revoked_at']" && pass "admin revoked the key"
R=$(mcp "$B_KEY" tools/call '{"name":"woo__list_orders","arguments":{}}')
echo "$R" | grep -q "revoked" && pass "rejected: $(echo "$R" | json "print(d['error']['message'])")" || fail "revoked key still works: $R"
B_KEY=$(api "$B_JAR" POST /api/keys '{"name":"second"}' | json "print(d['key'])")   # fresh key for the next tests

echo "== 5. Disable a server: its tools vanish"
TID=$(server_id toolbox)
api "$ADMIN_JAR" PATCH "/api/servers/$TID" '{"enabled":false}' | json "print('        toolbox status ->', d['server']['status'])"
tool_names "$B_KEY" | grep -q toolbox__ && fail "toolbox tools still listed" || pass "toolbox tools gone from tools/list"
mcp "$B_KEY" tools/call '{"name":"toolbox__calculate","arguments":{"expression":"1+1"}}' | json "print('        direct call ->', d['result']['content'][0]['text'])"
api "$ADMIN_JAR" PATCH "/api/servers/$TID" '{"enabled":true}' | json "print('        re-enabled, status ->', d['server']['status'], len(d['server']['tools']), 'tools')"

echo "== 6. Kill an upstream: the others keep working"
kubectl -n mcp-servers scale deploy/mcp-notes --replicas=0 >/dev/null
kubectl -n mcp-servers wait --for=delete pod -l app=mcp-notes --timeout=60s >/dev/null 2>&1 || true
mcp "$B_KEY" tools/call '{"name":"notes__list_notes","arguments":{}}' | json "print('        notes call   ->', d['result']['content'][0]['text'])"
api "$ADMIN_JAR" GET /api/servers | json "[print(f\"        {s['slug']:8} {s['status']:12} {s['last_error'] or ''}\") for s in d['servers']]"
tool_names "$B_KEY" | grep -q notes__ && fail "dead server's tools still listed" || pass "notes tools hidden while it is down"
mcp "$B_KEY" tools/call '{"name":"woo__list_products","arguments":{}}' | json "assert not d['result'].get('isError')" && pass "woo still works"
mcp "$B_KEY" tools/call '{"name":"toolbox__calculate","arguments":{"expression":"(499+25)*2"}}' | json "assert not d['result'].get('isError')" && pass "toolbox still works"
kubectl -n mcp-servers scale deploy/mcp-notes --replicas=1 >/dev/null
kubectl -n mcp-servers rollout status deploy/mcp-notes --timeout=120s >/dev/null
for i in $(seq 1 15); do tool_names "$B_KEY" | grep -q notes__ && break; sleep 2; done
tool_names "$B_KEY" | grep -q notes__ && pass "notes back after restart (picked up by the periodic check)" || fail "notes did not come back"

echo "== 7. Audit log (latest entries)"
api "$ADMIN_JAR" GET "/api/audit?limit=12" | json "[print(f\"        {e['ts'][11:19]}  {(e['user_email'] or '-'):22} {e['source']:4} {(e['server_slug'] or '-'):8} {(e['tool'] or '-'):18} {e['duration_ms']:>5}ms  {e['outcome']:11} {(e['error'] or '')[:60]}\") for e in reversed(d['entries'])]"

rm -rf "$WORK"
echo "All checks passed."
