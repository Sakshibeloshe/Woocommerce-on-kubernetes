# System design and tradeoffs

## Architecture

Five workloads plus two databases, in three namespaces:

| Namespace | Workloads | Public? |
|---|---|---|
| `store` | WordPress (Deployment), MySQL (StatefulSet), WooCommerce MCP server, store-setup Job | storefront only, via Ingress |
| `mcp-servers` | notes MCP server, toolbox MCP server | no |
| `gateway` | gateway (Deployment), dashboard (Deployment), Postgres (StatefulSet) | dashboard + `/api` + `/mcp`, via one Ingress host |

Request paths:
- **Customer**: browser → Traefik → WordPress → MySQL.
- **MCP client** (Claude Code, Cursor, Inspector): `POST /mcp` with `Authorization: Bearer mcpgw_…`
  → Traefik → gateway → (upstream MCP server) → (WordPress REST API) → back.
- **Dashboard**: static React app from nginx; it calls `/api/*` on the same host (session cookie).
- **Chat**: dashboard → `/api/chat` → gateway → LLM; tool calls go through the same gateway
  code path as MCP clients.

### Main choices

| Choice | Why | Tradeoff |
|---|---|---|
| **TypeScript everywhere** (MCP servers, gateway, dashboard) | one language, the official MCP TypeScript SDK on both sides | — |
| **Gateway = one service** with REST API, `/mcp` and the chat | the chat must use exactly the same routing, permissions and audit as MCP clients; one process makes that a function call (`callTool`) instead of a network hop | the gateway is the central component; it's stateless, so it scales horizontally |
| **Stateless Streamable HTTP** on `/mcp` (fresh MCP server object per request, no session id) | any replica can serve any request; no sticky sessions; a restarted pod loses nothing | no server-initiated notifications to clients (e.g. `tools/list_changed`); clients re-list tools when they reconnect |
| **Postgres** for users, keys, servers, audit | relational data with constraints, concurrent writers (several gateway replicas), easy to justify | one more StatefulSet to operate |
| **Separate namespaces** + default-deny NetworkPolicies | isolation is expressed as data (labels), visible with `kubectl get networkpolicy` | policies must be maintained with the components |
| **One Helm chart with plain templates** | simpler than umbrella + subcharts for a single team; one `helm install` | less reuse of individual parts (e.g. installing a second store) |
| **k3d locally, k3s on the VPS** | the same distribution (Traefik, local-path storage, kube-router NetworkPolicies) in both places | — |
| **LLM via any OpenAI-compatible API** | Ollama locally (free, offline), Groq/Gemini on a VPS, by configuration only | no provider-specific features |

### GEO readiness

The dashboard's GEO readiness page assesses published WooCommerce products using deterministic
listing checks: descriptive names and descriptions, categories/tags, structured attributes,
image alt text, price, and published/stock status. It returns a weighted completeness score and
specific suggestions. This score describes the listing fields present in WooCommerce; it is not
an AI ranking prediction or a guarantee of visibility. The dashboard calls the assessment through
the WooCommerce MCP tool and gateway, so the store credential remains in the WooCommerce service
and each assessment is recorded in the gateway audit log.

## How the WooCommerce MCP server talks to the store

The MCP server calls the **WooCommerce REST API** (`/wp-json/wc/v3/...`) at the in-cluster
Service `http://wordpress.store.svc`, authenticated with a WooCommerce consumer key/secret.

Why REST, and not WP-CLI or SQL:
- it's WooCommerce's public, versioned API: it applies business logic (stock, totals, hooks,
  emails), which direct SQL would bypass;
- WP-CLI would need the MCP server to run PHP inside the WordPress filesystem (shared volume,
  much broader access);
- the key is **scoped and revocable** independently of any human account.

Details:
- **Key provisioning**: WooCommerce has no CLI command for API keys. The chart generates the key
  and secret into a Secret; the setup Job inserts them into WooCommerce's
  `woocommerce_api_keys` table with WooCommerce's own `wc_api_hash()` (only the hash of the key is
  stored, exactly like the admin screen does) (`charts/platform/files/store-setup/ensure-api-key.php`).
  The MCP server reads the same Secret. Rotating = change the Secret, rerun the hook.
- **HTTP inside the cluster**: WooCommerce only accepts key:secret (basic auth) over HTTPS; over
  plain HTTP it expects OAuth 1.0a signatures. The official WordPress image already trusts
  `X-Forwarded-Proto: https`, so the MCP server sends that header on in-cluster calls. From
  outside, Traefik overwrites the header with the real scheme, so nobody can use this trick through
  the Ingress. The credential travels unencrypted only inside the cluster network, on a path the
  NetworkPolicies limit to MCP server → WordPress. (Alternative considered: OAuth 1.0a signing;
  more code, no extra protection inside the cluster.)
- **"Today"**: computed in the store's timezone (`STORE_TIMEZONE`, also set in WordPress), so
  "orders that came in today" matches what the shop owner sees.
- Responses are trimmed to the fields a model needs (fewer tokens, less noise).

## Tool aggregation, routing and failure handling

All in `gateway/src/upstreams.ts` and `gateway/src/gateway.ts`.

**Registry.** Upstreams live in Postgres (`upstream_servers`): slug, name, URL, enabled flag and
an optional credential (bearer token or custom header), encrypted with AES-256-GCM. The first
servers are seeded once on first start (WooCommerce first); afterwards the registry belongs to
the admins.

**Connections.** The gateway keeps one MCP client (Streamable HTTP) per enabled upstream. Every
10 seconds, and immediately after an admin change, it checks every upstream **in parallel**
(`Promise.allSettled`): connect if needed, fetch `tools/list` (paginated), record the status
(Connected / Unreachable / Disabled) and the reason for a failure. Each replica re-reads the
registry from Postgres on every cycle, so changes made through another replica arrive within one
interval.

**Aggregation.** `tools/list` is answered from the **cache** of the last successful listing of
every enabled, connected server. Listing never waits for an upstream, so a slow or dead server
can't slow it down or break it.

**Naming and collisions.** Every tool is exposed as `<slug>__<tool>` (e.g. `woo__list_orders`).
Slugs are unique (database constraint), immutable (renaming would silently rename every tool
clients rely on), and restricted to lowercase letters, digits and single hyphens, so they can
never contain the `__` separator. Two servers with a tool of the same name therefore always get
different exposed names. Routing uses a lookup table (exposed name → server id + original name),
not string splitting. Names longer than 64 characters (a limit of several LLM APIs) are shortened
deterministically with a hash suffix. Descriptions get a `[Server name]` prefix and are capped.

**Routing a call.** `callTool(caller, name, args)` resolves the name, forwards the call to that
upstream with **only that upstream's stored credential** (the client's API key is never
forwarded), and writes an audit row whatever happens.

**Failure handling.**

| Situation | Behaviour |
|---|---|
| Upstream slow | connect and list time out after 5 s, calls after 30 s; the caller gets "did not answer within 30s". The connection is kept (slow is not dead) |
| Upstream dead (connection refused, DNS error) | marked Unreachable immediately, its tools disappear from `tools/list`, the reason is shown in the dashboard; the next cycle reconnects automatically |
| Upstream answers with a protocol error | returned as a clear tool error; the server stays Connected |
| Tool reports a failure (`isError`) | passed through unchanged; audited as `error` |
| Call to a tool of a disabled/unknown server | rejected with a tool error; audited as `rejected` |
| One upstream fails | no effect on the others: separate connections, `allSettled`, per-call timeouts |

Errors are returned as MCP tool results with `isError: true` (not protocol errors), so a model can
read them and explain them to the user.

## Identity, keys and audit

- **Roles**: `admin` (manages servers and members) and `member` (uses tools, manages own keys,
  sees own audit entries).
- **Dashboard login**: email + password (scrypt), session in a signed `httpOnly`, `SameSite=Lax`
  cookie; the user is re-read from the database on every request, so disabling takes effect at once.
- **Members join by invite**: one-time link, only a hash of the token is stored, expires in 7 days.
- **API keys**: 256-bit random, prefixed `mcpgw_`, shown once; stored as SHA-256 (high entropy, so
  a fast hash is fine and allows a single indexed lookup), with a short prefix for display.
  Revocation sets `revoked_at`; every request looks the key up, so the next call fails.
- **Audit log** (`audit_log`): user, key, source (chat / MCP client), server, tool, timestamp,
  duration, outcome (`success`, `error`, `timeout`, `unreachable`, `rejected`) and error text.
  Rejected calls are logged too, attributed to the key's owner when the key is known (e.g. revoked).

## Chat agent

`gateway/src/chat.ts`. The backend receives the conversation, sends it to the LLM with the
**logged-in user's** tool list (converted to OpenAI function format), executes the requested tool
calls through `callTool()` with the user's identity (source `chat`), sends the results back, and
repeats until a plain-text answer or 8 rounds. The response includes every tool call (name,
arguments, result, duration), which the UI shows. The system prompt tells the model to treat tool
results as data and not to invent values.

Local default: Ollama with `qwen3:8b`, with "thinking" disabled (`reasoning_effort: none`, ~4×
faster on a laptop GPU).

## Kubernetes details

- **Storage**: MySQL and Postgres are StatefulSets with `volumeClaimTemplates`; WordPress files and
  notes use PVCs. Database PVCs and Secrets carry `helm.sh/resource-policy: keep`, so an accidental
  `helm uninstall` doesn't destroy data or the passwords that open it.
- **Probes**: readiness = can serve (WordPress: `/wp-login.php`, which needs PHP and the database;
  gateway: `/readyz` includes a DB check); liveness = process alive (WordPress: TCP only, so a
  database outage doesn't restart WordPress); startup probes for the databases' first boot.
- **Setup Job as a Helm hook** (`post-install,post-upgrade`): Helm creates/updates all normal
  resources first, then runs the Job; the script waits for WordPress' files and MySQL itself.
  Every step is idempotent, which is what makes running it on every upgrade safe (it also performs
  WooCommerce upgrades when the pinned version changes).
- **Secrets**: generated randomly on first install and reused on upgrades through Helm `lookup`;
  or created beforehand (`secrets.generate: false`), e.g. in production.
- **NetworkPolicies**: default deny (ingress and egress) in every namespace, then explicit allows:
  DNS for all; ingress controller → WordPress, dashboard, gateway; gateway → Postgres and the MCP
  servers; MCP server → WordPress; WordPress and the setup Job → MySQL and the internet; gateway →
  the LLM (`gateway.extraEgress`).

## What changes for production

Only values (`values-prod.yaml`); see the table in [vps.md](vps.md).

| Concern | Local | Production |
|---|---|---|
| DNS | `*.localtest.me` → 127.0.0.1 | real domain A records, or `*.<IP>.nip.io` |
| Ingress | Traefik in k3d, plain HTTP | Traefik in k3s, TLS via cert-manager + Let's Encrypt; session cookies become `Secure` |
| Storage class | cluster default (local-path) | `local-path` explicitly, larger volumes; a managed cluster would use its cloud StorageClass |
| Secrets | generated by Helm | created before install with `k8s/create-secrets.sh` / `kubectl create secret`; LLM key in its own Secret |
| Images | built locally and imported | pushed to a registry (`global.imageRegistry`) |
| LLM | Ollama on the laptop | Groq / Gemini over HTTPS |
| Gateway | 1 replica | 2 replicas |

## Known limitations

- Rate limits and upstream status are kept **per gateway replica** (in memory); exact global
  limits across replicas would need a shared store such as Redis.
- No per-role or per-tool permissions: any member may call any tool of any enabled server
  (including writes such as `create_product`). See the threat model.
- Kubernetes Secrets are only base64-encoded in etcd unless the cluster enables secrets
  encryption (k3s: `--secrets-encryption`).
- WordPress runs its official image, which starts Apache as root (it serves requests as
  `www-data`); all other containers run as non-root.
- The gateway doesn't send `tools/list_changed` to clients (stateless transport), so a client sees a
  changed tool list when it lists again or reconnects.
- A local 8B model is slow (tens of seconds per answer) and sometimes imprecise; the tool loop
  itself doesn't depend on the model.
