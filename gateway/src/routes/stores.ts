import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireSession, type User } from "../auth.js";
import { config } from "../config.js";
import { pool } from "../db.js";
import { ah, isUniqueViolation, parseBody } from "../http.js";
import { upstreams } from "../upstreams.js";
import { validateUpstreamUrl } from "../ssrf.js";

export const storesRouter = Router();
storesRouter.use(requireSession);

const slugSchema = z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and single hyphens").max(16);
const storeProjection = "s.id, s.owner_user_id, u.email AS owner_email, s.slug, s.title, s.namespace, " +
  "s.release_name, s.hostname, s.status, s.last_error, s.created_at, s.updated_at";
const isAdmin = (user: User | undefined) => user?.role === "admin";

storesRouter.get("/", ah(async (req, res) => {
  const query = isAdmin(req.user)
    ? "SELECT " + storeProjection + " FROM stores s JOIN users u ON u.id = s.owner_user_id ORDER BY s.created_at DESC"
    : "SELECT " + storeProjection + " FROM stores s JOIN users u ON u.id = s.owner_user_id WHERE s.owner_user_id = $1 ORDER BY s.created_at DESC";
  const { rows } = await pool.query(query, isAdmin(req.user) ? [] : [req.user!.id]);
  res.json({ stores: rows, max_per_user: config.stores.maxPerUser });
}));

storesRouter.post("/", ah(async (req, res) => {
  const body = parseBody(z.object({
    slug: slugSchema,
    title: z.string().trim().min(1).max(80),
  }), req, res);
  if (!body) return;

  const id = randomUUID();
  const namespace = "store-" + body.slug + "-" + id.slice(0, 8);
  const hostname = "store-" + body.slug + "." + config.stores.hostSuffix;
  const releaseName = "shop-" + id.slice(0, 8);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [req.user!.id]);
    const { rows: countRows } = await client.query(
      "SELECT count(*)::int AS count FROM stores WHERE owner_user_id = $1 AND status <> 'deleted'",
      [req.user!.id]
    );
    if (countRows[0].count >= config.stores.maxPerUser) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "You can have at most " + config.stores.maxPerUser + " active stores" });
    }
    const { rows } = await client.query(
      `INSERT INTO stores (id, owner_user_id, slug, title, namespace, release_name, hostname, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'waiting_for_namespace')
       RETURNING id, slug, title, namespace, release_name, hostname, status, last_error, created_at, updated_at`,
      [id, req.user!.id, body.slug, body.title, namespace, releaseName, hostname]
    );
    await client.query("COMMIT");
    res.status(201).json({ store: { ...rows[0], owner_email: req.user!.email } });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if (isUniqueViolation(e)) return res.status(409).json({ error: "The store slug " + body.slug + " is already in use" });
    throw e;
  } finally {
    client.release();
  }
}));

storesRouter.post("/:id/provision", ah(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Only an admin can start provisioning" });
  const { rows } = await pool.query(
    `UPDATE stores SET status = 'provisioning', last_error = NULL, updated_at = now()
      WHERE id = $1 AND status IN ('waiting_for_namespace', 'failed')
      RETURNING id, slug, title, namespace, release_name, hostname, status, last_error, created_at, updated_at`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(409).json({ error: "Store is not waiting to be provisioned" });
  res.json({ store: { ...rows[0], owner_email: req.user!.email } });
}));

storesRouter.post("/:id/register", ah(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Only an admin can register a provisioned store" });
  const { rows: found } = await pool.query(
    "SELECT id, slug, title, namespace, hostname, status FROM stores WHERE id = $1 AND status IN ('provisioning', 'failed')",
    [req.params.id]
  );
  const store = found[0];
  if (!store) return res.status(409).json({ error: "Store must be in provisioning or failed status" });

  const url = "http://mcp-woocommerce." + store.namespace + ".svc/mcp";
  const refused = await validateUpstreamUrl(url);
  if (refused) {
    await pool.query("UPDATE stores SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1", [store.id, refused]);
    return res.status(502).json({ error: "Store MCP endpoint is not reachable: " + refused });
  }

  const client = await pool.connect();
  let upstreamId: string;
  try {
    await client.query("BEGIN");
    const { rows: locked } = await client.query("SELECT status FROM stores WHERE id = $1 FOR UPDATE", [store.id]);
    if (!locked[0] || !["provisioning", "failed"].includes(locked[0].status)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Store changed state while registration was starting" });
    }
    const { rows } = await client.query(
      `INSERT INTO upstream_servers (slug, name, url, enabled, credential_type, store_id)
       VALUES ($1, $2, $3, true, 'none', $4)
       ON CONFLICT (store_id) WHERE store_id IS NOT NULL
       DO UPDATE SET slug = EXCLUDED.slug, name = EXCLUDED.name, url = EXCLUDED.url, enabled = true, updated_at = now()
       RETURNING id`,
      ["store-" + store.slug, store.title, url, store.id]
    );
    upstreamId = rows[0].id;
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if (isUniqueViolation(e)) return res.status(409).json({ error: "A gateway server already uses the reserved store tool prefix" });
    throw e;
  } finally {
    client.release();
  }

  await upstreams.refreshNow(upstreamId);
  const live = upstreams.snapshot().find((entry) => entry.id === upstreamId);
  const ready = live?.status === "connected";
  const error = ready ? null : live?.last_error ?? "The WooCommerce MCP server is not connected yet";
  const { rows: updated } = await pool.query(
    "UPDATE stores SET status = $2, last_error = $3, updated_at = now() WHERE id = $1 RETURNING id, slug, title, namespace, release_name, hostname, status, last_error, created_at, updated_at",
    [store.id, ready ? "ready" : "failed", error]
  );
  res.status(ready ? 200 : 502).json({ store: { ...updated[0], owner_email: req.user!.email } });
}));

storesRouter.delete("/:id", ah(async (req, res) => {
  const admin = isAdmin(req.user);
  const client = await pool.connect();
  let store: { id: string; owner_user_id: string; namespace: string; status: string };
  let updated: Record<string, unknown>;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT id, owner_user_id, namespace, status FROM stores
        WHERE id = $1 AND ($2::boolean OR owner_user_id = $3) FOR UPDATE`,
      [req.params.id, admin, req.user!.id]
    );
    store = rows[0];
    if (!store || store.status === "deleted" || store.status === "cleanup_pending") {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Store not found, already deleted, or not owned by you" });
    }
    await client.query("DELETE FROM upstream_servers WHERE store_id = $1", [store.id]);
    const { rows: changed } = await client.query(
      `UPDATE stores SET status = 'cleanup_pending', last_error = $2, updated_at = now()
        WHERE id = $1
        RETURNING id, slug, title, namespace, release_name, hostname, status, last_error, created_at, updated_at`,
      [store.id, "Gateway tools are removed. An admin must delete namespace " + store.namespace + " and confirm cleanup."]
    );
    updated = changed[0];
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  await upstreams.refreshNow();
  res.status(202).json({ store: { ...updated!, owner_email: req.user!.email } });
}));

storesRouter.post("/:id/confirm-namespace-deleted", ah(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Only an admin can confirm namespace removal" });
  const { rows } = await pool.query(
    `UPDATE stores SET status = 'deleted', last_error = NULL, deleted_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'cleanup_pending'
      RETURNING id`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(409).json({ error: "Store is not waiting for namespace cleanup" });
  res.json({ ok: true });
}));
