# WooCommerce on Kubernetes with a Team MCP Gateway

A WooCommerce store on Kubernetes, plus a **team MCP gateway**: an admin connects MCP servers
once in a dashboard, and every team member uses all of them through **one MCP endpoint and one
personal API key**, or through a chat agent in the dashboard. Upstream credentials never leave
the server side, and every tool call is audited.

Everything runs in the cluster and installs with **one Helm chart**; local (k3d) and a VPS (k3s)
differ only in values files.

| Doc | Contents |
|---|---|
| [docs/design.md](docs/design.md) | System design and tradeoffs |
| [docs/threat-model.md](docs/threat-model.md) | Threat model |
| [docs/vps.md](docs/vps.md) | Production-like setup on a VPS (k3s) |

---

## What's inside

```
 Customers ─▶ store.localtest.me ─▶ Traefik ─▶ WordPress + WooCommerce ─▶ MySQL
                                                   ▲ REST API (key from a Secret)
 Team ─▶ dashboard.localtest.me ─▶ Traefik ─┬─▶ dashboard (React)
 MCP clients ─▶ dashboard.localtest.me/mcp ─┘─▶ gateway ─▶ Postgres (users, keys, servers, audit)
                                                   │ MCP client to every upstream
                     ┌─────────────────────────────┼──────────────────────────┐
                     ▼                             ▼                          ▼
          mcp-woocommerce (store ns)    mcp-notes (bearer token)      mcp-toolbox
          └──────── no Ingress; NetworkPolicy: only gateway pods may connect ────────┘
 Chat agent (in the gateway) ─▶ LLM (Ollama locally, any OpenAI-compatible API)
```

| Component | Folder | What it does |
|---|---|---|
| Store | `charts/platform/templates/store` | WordPress + WooCommerce + MySQL on persistent volumes; configured automatically by a WP-CLI Job (Helm hook) |
| WooCommerce MCP server | `mcp-woocommerce/` | **Written for this project.** Streamable HTTP; product and order tools, plus rule-based GEO readiness assessments for published product listings |
| Notes MCP server | `mcp-notes/` | Shared team notes (`create_note`, `list_notes`, `delete_note`); **requires a bearer token**, to demonstrate upstream credentials |
| Toolbox MCP server | `mcp-toolbox/` | `convert_currency`, `get_current_time`, `calculate` |
| Gateway | `gateway/` | MCP client to every registered server and MCP server to clients (`/mcp`); users, roles, API keys, upstream registry, audit log, chat agent (`/api/...`) |
| Dashboard | `dashboard/` | React UI: servers, team, keys, audit log, chat |
| Helm chart | `charts/platform/` | Everything above, with `values-local.yaml` and `values-prod.yaml` |

`woo-sandbox/` (Docker Compose) and `k8s/` (plain manifests) are the earlier learning steps;
the Helm chart is the supported install.

---

## Local setup

### Prerequisites
- **Docker Desktop** (running)
- **k3d**, **kubectl**, **Helm** (Windows: `winget install k3d.k3d Helm.Helm`; kubectl comes with Docker Desktop)
- **Git Bash** on Windows (the scripts are bash; PowerShell's `bash` command is WSL, which has no kubectl)
- Optional, for the chat agent: **Ollama** with a tool-calling model: `ollama pull qwen3:8b`

### Local domains
The chart uses `store.localtest.me` and `dashboard.localtest.me`. `localtest.me` is a public
DNS name whose every subdomain resolves to `127.0.0.1`, so no hosts-file editing is needed.
k3d maps your ports 80/443 to Traefik, which routes by host name.

### Install (one command)
```powershell
& "C:\Program Files\Git\bin\bash.exe" scripts/local-up.sh     # Windows
```
```bash
bash scripts/local-up.sh                                       # macOS / Linux
```
It creates the k3d cluster `woo` (if missing), builds the five images, loads them and the public
images into the cluster, and runs:
```bash
helm upgrade --install platform charts/platform -f charts/platform/values-local.yaml --timeout 15m --wait
```
The first run takes ~15–20 minutes (image downloads, WooCommerce install). Re-running is safe.

Check: `kubectl get pods -A`. Everything `Running`, `store-setup` `Completed`.

### Passwords
Generated on first install and stored in Secrets (never in git):
```bash
# dashboard: admin@example.com
kubectl -n gateway get secret gateway-secrets -o jsonpath='{.data.admin-password}' | base64 -d
# WordPress admin: user "admin"
kubectl -n store get secret wordpress-admin -o jsonpath='{.data.password}' | base64 -d
```
PowerShell has no `base64`; use:
```powershell
[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String((kubectl -n gateway get secret gateway-secrets -o jsonpath='{.data.admin-password}')))
```

### Remove
```bash
k3d cluster delete woo
```

---

## Using it

### Place an order
1. Open **http://store.localtest.me**, add a product (e.g. "Kubernetes Mug") to the cart, check out.
2. Any test address; payment **Cash on delivery** → *Place order*.
3. See it in **http://store.localtest.me/wp-admin** → WooCommerce → Orders.

### Dashboard
**http://dashboard.localtest.me**, log in as `admin@example.com`.
- **Servers**: status (Connected / Unreachable / Disabled) and tools of each server; admins add
  (URL + optional bearer/header credential), edit, disable, remove.
- **Team** (admins): invite members (one-time invite link), change roles, issue/revoke keys.
- **My API keys**: every user generates their own keys (shown once, stored hashed).
- **Audit log**: every tool call: who, via (chat / MCP client), server, tool, duration, outcome.
- **Chat**: the agent.
- **GEO readiness**: rule-based product listing checks with weighted completeness scores and concrete recommendations. This is a listing-quality diagnostic, not a promise of ranking or citations in any particular AI system.

### Connect an external MCP client
Generate a key under **My API keys**, then use only the gateway URL and the key.

Claude Code:
```bash
claude mcp add --transport http gateway http://dashboard.localtest.me/mcp --header "Authorization: Bearer mcpgw_..."
```
Cursor (`~/.cursor/mcp.json`):
```json
{ "mcpServers": { "gateway": { "url": "http://dashboard.localtest.me/mcp",
                               "headers": { "Authorization": "Bearer mcpgw_..." } } } }
```
MCP Inspector: `npx @modelcontextprotocol/inspector` → Transport *Streamable HTTP*, URL
`http://dashboard.localtest.me/mcp`, header `Authorization: Bearer mcpgw_...` → *List Tools*.

Tools appear as `<server>__<tool>`, e.g. `woo__list_orders`, `notes__create_note`.

### Chat agent
Dashboard → **Chat**. Examples: *"Create a product named Demo Hoodie priced 99"*, *"What orders
came in today?"*, *"List today's orders and save a note summarizing them"*. Each answer shows
the tools it called; the calls appear in the audit log under your name.

Locally it uses Ollama on your machine (`values-local.yaml`: `http://host.docker.internal:11434/v1`,
`qwen3:8b`). Any OpenAI-compatible API works (Groq, Gemini, OpenRouter): set `gateway.llm.baseUrl`,
`gateway.llm.model` and put the API key in a Secret referenced by `gateway.llm.existingSecret`.

---

## Production-like setup (VPS with k3s)

Same chart, different values file: [`charts/platform/values-prod.yaml`](charts/platform/values-prod.yaml).
Full runbook in **[docs/vps.md](docs/vps.md)**. In short:
1. `curl -sfL https://get.k3s.io | sh -` on the VPS; use its kubeconfig locally.
2. DNS: real domain or `store.<IP>.nip.io` / `dashboard.<IP>.nip.io`.
3. Push the five images to a registry (`global.imageRegistry`).
4. Optional TLS: cert-manager + a Let's Encrypt `ClusterIssuer` (`ingress.tls`).
5. Secrets **before** install: `bash k8s/create-secrets.sh` and the LLM key
   (`kubectl -n gateway create secret generic llm-api-key --from-literal=api-key=...`).
6. `helm upgrade --install platform charts/platform -f charts/platform/values-prod.yaml --timeout 15m --wait`

Upgrades: bump an image tag in values → `helm upgrade`. Rollback: `helm history platform`,
`helm rollback platform <revision>` (restores manifests; take DB backups before schema upgrades).

## Free demo deployment

For a short demo, keep the project running on your PC with k3d and expose the dashboard with a
Cloudflare Quick Tunnel:

```bash
cloudflared tunnel --url http://dashboard.localtest.me
```

Cloudflare prints a temporary public HTTPS URL. Keep Docker Desktop, k3d, and the tunnel process
running while people use it. Quick Tunnels are temporary and intended for development, not a
permanent deployment. The dashboard is public at that URL, so use demo data and remove the tunnel
when finished. See [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/) and
[Quick Tunnels](https://developers.cloudflare.com/workers/wrangler/commands/tunnel/).

For a cloud-hosted demo, Oracle Cloud's Always Free allowance currently includes up to 2 Ampere A1
OCPUs and 12 GB of memory in the tenancy's home region. The project's k3s Helm setup is documented
in [docs/vps.md](docs/vps.md). Use one gateway replica on a single free VM, publish the project
images to a registry, and build them for `linux/arm64` because Ampere is ARM-based. The GEO page
does not need an LLM API key. Free capacity can be unavailable in some regions, and Oracle may
reclaim idle Always Free instances; treat this as a demo host, not production hosting. Check
[Oracle's current Always Free limits](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
before creating resources.

---

## Tests

| Command (Git Bash) | Checks |
|---|---|
| `bash k8s/test-gateway.sh` | Invite a member, key shown once, tools of all 3 servers, routing, revoked key rejected, disabled server's tools vanish, killed upstream doesn't break others, audit entries |
| `bash scripts/test-hardening.sh` | 24 security controls, each shown with a command that must fail: NetworkPolicies, non-root/read-only containers, SSRF guard, rate limits |

---

## Requirements → where they are

| Requirement | Where |
|---|---|
| Local k8s + VPS with the same Helm chart, values only | `charts/platform`, `values-local.yaml`, `values-prod.yaml` |
| Everything in the cluster, persistent storage | StatefulSets for MySQL/Postgres, PVCs for WordPress and notes |
| Ingress with stable URLs, local domain approach | `*.localtest.me` (above) |
| Probes, requests/limits on every workload | every Deployment/StatefulSet/Job in `charts/platform/templates` |
| No hardcoded secrets | Secrets generated by the chart (`secrets.yaml`) or `k8s/create-secrets.sh` |
| Own WooCommerce MCP server, Streamable HTTP, product/order tools and GEO assessment, cluster-internal | `mcp-woocommerce/`, no Ingress + NetworkPolicy |
| How it talks to the store | WooCommerce REST API; see [design.md](docs/design.md#how-the-woocommerce-mcp-server-talks-to-the-store) |
| Gateway: add/edit/disable/remove servers with credentials | `gateway/src/routes/servers.ts` |
| One endpoint, union of tools, routing, name collisions | `gateway/src/mcp.ts`, `upstreams.ts` (`slug__tool`) |
| Slow/dead upstream isolation, timeouts | `upstreams.ts` (cache, `allSettled`, 5 s / 30 s timeouts) |
| Upstream credentials server-side only | encrypted at rest, write-only API, never forwarded to clients |
| Three upstream servers | WooCommerce, notes, toolbox |
| Roles, per-user hashed revocable API keys, audit log | `auth.ts`, `routes/keys.ts`, `audit.ts`, Audit page |
| Chat agent acting as the logged-in user | `gateway/src/chat.ts` |
| GEO readiness assessment through the WooCommerce MCP path | `mcp-woocommerce/src/geo.ts`, `dashboard/src/pages/Geo.tsx` |

## Stand-out items attempted

| Item | Status | Where |
|---|---|---|
| 6. Security hardening | Done: SSRF guard (allowlist + connect-time IP check), default-deny NetworkPolicies per namespace, non-root containers (except the official WordPress image), read-only root filesystems, dropped capabilities, no service-account tokens mounted, upstream credentials encrypted at rest (AES-256-GCM), rate limits, timing-safe login | `gateway/src/ssrf.ts`, `ratelimit.ts`, `crypto.ts`, `charts/platform/templates/*/network-policies.yaml`, `scripts/test-hardening.sh` |
| 7. Scaling | Done: stateless `/mcp`, gateway tested with 2 replicas; per-key / per-user rate limits (in memory, per replica) | `values-prod.yaml` (`replicas: 2`), `ratelimit.ts` |
| 9. Upgrades and rollback | Done and documented: pinned image tags, idempotent setup hook, `helm history` / `rollback` | `docs/vps.md` |
| 1. VPS deployment | Documented and configured, see `docs/vps.md` | `values-prod.yaml` |
| 8. Observability | Partial: per-server status with the reason it's unreachable; failure reasons in the audit log. No metrics endpoint | Servers page, Audit page |
| 2. Tool permissions, 3. OAuth, 4. Many tools, 5. Hosted servers, multi-store bonus | Not attempted | |

## Repository layout
```
charts/platform/     Helm chart (templates, values, store setup scripts)
gateway/             gateway backend + chat agent (TypeScript, Express, MCP SDK)
dashboard/           React dashboard (Vite), served by nginx
mcp-woocommerce/     WooCommerce MCP server
mcp-notes/           notes MCP server (bearer token)
mcp-toolbox/         toolbox MCP server
scripts/             local-up.sh, test-hardening.sh
k8s/                 k3d cluster config, create-secrets.sh, test-gateway.sh, plain manifests (learning path)
woo-sandbox/         Docker Compose sandbox used to learn WooCommerce before Kubernetes
docs/                system design, threat model and VPS runbook
```
