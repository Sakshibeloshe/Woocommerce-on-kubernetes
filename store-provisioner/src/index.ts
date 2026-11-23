// Store provisioner: turns rows in the gateway's `stores` table into real, isolated stores.
//
//   status 'provisioning'    -> namespace + RoleBinding + `helm upgrade --install` + MCP registration -> 'ready'
//   status 'cleanup_pending' -> delete the namespace (DB, volumes, Secrets, release go with it)  -> 'deleted'
//
// Why a separate component: the gateway is internet-facing and holds no Kubernetes credentials.
// This process is not exposed at all and has narrow RBAC (see charts/platform/templates/provisioner).
//
// Safety / recovery:
//   - Every step is idempotent (create-if-missing, helm upgrade --install), so a retry or a restart
//     just runs the steps again. A release stuck in pending-* after a crash is uninstalled first.
//   - Deadline = updated_at + PROVISION_TIMEOUT_MINUTES. Past it, the store fails with a clear reason.
//   - Only one provisioner instance works at a time (Postgres advisory lock).
//   - kubectl/helm run via spawn with an argument list (no shell) and inputs are validated first.
import { spawn } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const env = process.env;
const cfg = {
  pollMs: Number(env.POLL_INTERVAL_MS ?? 5000),
  maxParallel: Math.max(1, Number(env.MAX_PARALLEL ?? 2)),
  timeoutMin: Number(env.PROVISION_TIMEOUT_MINUTES ?? 20),
  deleteTimeoutMin: Number(env.DELETE_TIMEOUT_MINUTES ?? 10),
  chart: env.STORE_CHART ?? "/app/charts/store",
  baseValues: env.STORE_BASE_VALUES ?? "/config/store-values.yaml",
  storeRole: env.STORE_CLUSTER_ROLE ?? "store-provisioner-store-admin",
  serviceAccount: env.SERVICE_ACCOUNT ?? "store-provisioner",
  podNamespace: env.POD_NAMESPACE ?? "gateway",
};
const MANAGED_BY = "platform.example/managed-by";
const MANAGER = "store-provisioner";

const NS_RE = /^store-[a-z][a-z0-9-]*-[a-f0-9]{8}$/;
const HOST_RE = /^store-[a-z][a-z0-9-]*\.[a-z0-9.-]+$/;
const RELEASE_RE = /^shop-[a-f0-9]{8}$/;
const SLUG_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

type Store = {
  id: string; slug: string; title: string; namespace: string; release_name: string;
  hostname: string; status: "provisioning" | "cleanup_pending"; updated_at: Date;
};

const pool = new pg.Pool({ max: 5 });
const inFlight = new Set<string>();
const manualNamespaces = new Map<string, number>();   // store id -> updated_at we already reported on
let lastTick = Date.now();

const log = (store: Pick<Store, "slug"> | null, msg: string) =>
  console.log(`${new Date().toISOString()} ${store ? `[${store.slug}] ` : ""}${msg}`);

// ---------- process helpers ----------

class CommandError extends Error {}

function exec(cmd: string, args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs) : undefined;
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new CommandError(lastLines(err || out) || `${cmd} exited with code ${code}`));
    });
    child.stdin.end(opts.input ?? "");
  });
}
const lastLines = (s: string) => s.trim().split("\n").slice(-4).join(" ").replace(/\s+/g, " ").slice(0, 600);
const kubectl = (args: string[], input?: string) => exec("kubectl", args, { input, timeoutMs: 120_000 });
const helm = (args: string[], timeoutMs: number) => exec("helm", args, { timeoutMs });

async function getNamespace(name: string): Promise<{ labels: Record<string, string> } | null> {
  try {
    const json = JSON.parse(await kubectl(["get", "namespace", name, "-o", "json"]));
    return { labels: json.metadata?.labels ?? {} };
  } catch (e) {
    if (e instanceof CommandError && /NotFound|not found/i.test(e.message)) return null;
    throw e;
  }
}

// ---------- DB helpers (all guarded by the expected status, so user actions always win) ----------

const note = (id: string, text: string) =>
  pool.query("UPDATE stores SET last_error = $2 WHERE id = $1 AND status = 'provisioning'", [id, text]);

const fail = (id: string, reason: string) =>
  pool.query("UPDATE stores SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1 AND status = 'provisioning'",
    [id, reason.slice(0, 900)]);

// ---------- provisioning ----------

async function provision(store: Store) {
  if (!NS_RE.test(store.namespace) || !HOST_RE.test(store.hostname) || !RELEASE_RE.test(store.release_name) || !SLUG_RE.test(store.slug)) {
    return fail(store.id, "Refusing to provision: unexpected namespace, hostname, release or slug format");
  }
  const deadline = store.updated_at.getTime() + cfg.timeoutMin * 60_000;
  const remaining = () => Math.floor((deadline - Date.now()) / 1000);
  if (remaining() <= 30) {
    return fail(store.id, `Provisioning timed out after ${cfg.timeoutMin} minutes. Resources are kept; click Retry to resume.`);
  }

  // 1. Namespace, labelled so the admission policy lets us manage it and the gateway may reach its MCP server.
  await note(store.id, "Creating namespace…");
  const existing = await getNamespace(store.namespace);
  if (existing && existing.labels[MANAGED_BY] !== MANAGER) {
    return fail(store.id, `Namespace ${store.namespace} already exists and was not created by the provisioner (operator-made?). Delete it or use the operator scripts.`);
  }
  if (!existing) {
    await kubectl(["create", "-f", "-"], JSON.stringify({
      apiVersion: "v1", kind: "Namespace",
      metadata: {
        name: store.namespace,
        labels: { "platform.example/store": "true", [MANAGED_BY]: MANAGER, "platform.example/store-slug": store.slug },
      },
    }));
  }

  // 2. Our permissions inside this namespace only (the store-admin ClusterRole, bound per namespace).
  await kubectl(["apply", "-f", "-"], JSON.stringify({
    apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding",
    metadata: { name: MANAGER, namespace: store.namespace, labels: { [MANAGED_BY]: MANAGER } },
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: cfg.storeRole },
    subjects: [{ kind: "ServiceAccount", name: cfg.serviceAccount, namespace: cfg.podNamespace }],
  }));

  // 3. A release left in pending-* by a crash blocks upgrades: reset it (a brand-new store has no data to lose).
  try {
    const status = JSON.parse(await helm(["status", store.release_name, "-n", store.namespace, "-o", "json"], 60_000));
    const phase: string = status?.info?.status ?? "";
    if (phase.startsWith("pending")) {
      log(store, `release stuck in ${phase}, uninstalling before retry`);
      await helm(["uninstall", store.release_name, "-n", store.namespace, "--wait", "--timeout", "5m"], 6 * 60_000);
    }
  } catch { /* no release yet */ }

  // 4. Install / resume. Same chart as the operator scripts, values from the platform release + this store.
  await note(store.id, "Installing WordPress, WooCommerce and the MCP server…");
  const valuesFile = join(tmpdir(), `store-${store.id}.json`);
  await writeFile(valuesFile, JSON.stringify({
    namespaces: { store: store.namespace, create: false },
    store: { host: store.hostname, title: store.title, adminEmail: `admin@${store.hostname}` },
  }));
  try {
    const seconds = remaining();
    await helm(["upgrade", "--install", store.release_name, cfg.chart, "-n", store.namespace,
      "-f", cfg.baseValues, "-f", valuesFile, "--wait", "--wait-for-jobs", "--timeout", `${seconds}s`],
      (seconds + 60) * 1000);
  } finally {
    await rm(valuesFile, { force: true });
  }

  // 5. Register its MCP server with the gateway (the gateway picks it up on its next refresh).
  await note(store.id, "Registering the store's MCP server with the gateway…");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT status FROM stores WHERE id = $1 FOR UPDATE", [store.id]);
    if (rows[0]?.status !== "provisioning") { await client.query("ROLLBACK"); return log(store, "status changed meanwhile, not registering"); }
    await client.query(
      `INSERT INTO upstream_servers (slug, name, url, enabled, credential_type, store_id)
       VALUES ($1, $2, $3, true, 'none', $4)
       ON CONFLICT (store_id) WHERE store_id IS NOT NULL
       DO UPDATE SET slug = EXCLUDED.slug, name = EXCLUDED.name, url = EXCLUDED.url, enabled = true, updated_at = now()`,
      [`store-${store.slug}`, store.title, `http://mcp-woocommerce.${store.namespace}.svc/mcp`, store.id]);
    await client.query("UPDATE stores SET status = 'ready', last_error = NULL, updated_at = now() WHERE id = $1", [store.id]);
    await client.query("COMMIT");
    log(store, "ready");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ---------- teardown ----------

async function teardown(store: Store) {
  if (!NS_RE.test(store.namespace)) return;
  const ns = await getNamespace(store.namespace);
  if (ns && ns.labels[MANAGED_BY] !== MANAGER) {
    // Created by the operator scripts: not ours to delete (and the admission policy would refuse anyway).
    if (manualNamespaces.get(store.id) !== store.updated_at.getTime()) {
      manualNamespaces.set(store.id, store.updated_at.getTime());
      await pool.query("UPDATE stores SET last_error = $2 WHERE id = $1 AND status = 'cleanup_pending'",
        [store.id, `Namespace ${store.namespace} was created by the operator scripts, so it is not deleted automatically. Delete it with scripts/delete-store-namespace, then confirm.`]);
    }
    return;
  }
  if (ns) {
    log(store, "deleting namespace");
    await exec("kubectl", ["delete", "namespace", store.namespace, "--wait=true", `--timeout=${cfg.deleteTimeoutMin}m`],
      { timeoutMs: (cfg.deleteTimeoutMin + 1) * 60_000 });
    if (await getNamespace(store.namespace)) throw new CommandError(`Namespace ${store.namespace} is still terminating`);
  }
  await pool.query("DELETE FROM upstream_servers WHERE store_id = $1", [store.id]);
  await pool.query(
    "UPDATE stores SET status = 'deleted', last_error = NULL, deleted_at = now(), updated_at = now() WHERE id = $1 AND status = 'cleanup_pending'",
    [store.id]);
  log(store, "deleted");
}

// ---------- loop ----------

async function work(store: Store) {
  inFlight.add(store.id);
  try {
    if (store.status === "provisioning") await provision(store);
    else await teardown(store);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(store, `error: ${msg}`);
    if (store.status === "provisioning") await fail(store.id, msg).catch(() => {});
    else await pool.query("UPDATE stores SET last_error = $2 WHERE id = $1 AND status = 'cleanup_pending'",
      [store.id, `Deletion will be retried: ${msg}`.slice(0, 900)]).catch(() => {});
  } finally {
    inFlight.delete(store.id);
  }
}

async function tick() {
  lastTick = Date.now();
  const { rows } = await pool.query<Store>(
    `SELECT id, slug, title, namespace, release_name, hostname, status, updated_at FROM stores
      WHERE status IN ('provisioning', 'cleanup_pending') ORDER BY updated_at`);
  for (const store of rows) {
    if (inFlight.has(store.id) || inFlight.size >= cfg.maxParallel) continue;
    void work(store);
  }
}

async function main() {
  // Health endpoint for the probes: unhealthy if the loop stops ticking.
  createServer((req, res) => {
    const ok = Date.now() - lastTick < Math.max(60_000, cfg.pollMs * 6);
    res.writeHead(ok ? 200 : 503, { "Content-Type": "text/plain" }).end(ok ? "ok\n" : "stale\n");
  }).listen(8080);

  // Single active instance: hold an advisory lock for the life of the process.
  const lockClient = await pool.connect();
  log(null, "waiting for the provisioner lock");
  await lockClient.query("SELECT pg_advisory_lock(hashtext('store-provisioner'))");
  log(null, `running: max ${cfg.maxParallel} in parallel, timeout ${cfg.timeoutMin} min, chart ${cfg.chart}`);

  const loop = async () => {
    try { await tick(); } catch (e) { log(null, `tick failed: ${e instanceof Error ? e.message : e}`); }
    setTimeout(loop, cfg.pollMs);
  };
  void loop();
}

process.on("SIGTERM", () => { log(null, "SIGTERM, exiting (in-flight work resumes on restart)"); process.exit(0); });
main().catch((e) => { console.error(e); process.exit(1); });

