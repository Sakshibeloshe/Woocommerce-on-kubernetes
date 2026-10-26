// Upstream registry. Everyone logged in can SEE servers, status and tools;
// only admins can add, edit, disable or remove them.
// Credentials are write-only: accepted on create/update, never returned.
import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { encrypt } from "../crypto.js";
import { requireAdmin, requireSession } from "../auth.js";
import { ah, isUniqueViolation, parseBody } from "../http.js";
import { upstreams, type ServerRow } from "../upstreams.js";
import { validateUpstreamUrl } from "../ssrf.js";

export const serversRouter = Router();
serversRouter.use(requireSession);

// Slugs become tool prefixes. Lowercase letters/digits with single hyphens, so they
// can never contain the "__" separator: "woo__list_orders" always splits unambiguously.
const slug = z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, "lowercase letters, digits and single hyphens").max(24)
  .refine((value) => !value.startsWith("store-"), 'the "store-" prefix is reserved for provisioned stores');
const url = z.string().url().refine((u) => /^https?:\/\//.test(u), "must be http(s)");
// Headers the gateway itself controls must not be overridden by a credential.
const FORBIDDEN_HEADERS = ["host", "content-length", "content-type", "accept", "connection", "transfer-encoding", "mcp-session-id", "mcp-protocol-version"];
const credential = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("bearer"), value: z.string().min(1).max(4096) }),
  z.object({
    type: z.literal("header"),
    header_name: z.string().regex(/^[A-Za-z0-9-]+$/).refine((h) => !FORBIDDEN_HEADERS.includes(h.toLowerCase()), "header not allowed"),
    value: z.string().min(1).max(4096),
  }),
]);

const createSchema = z.object({
  slug, name: z.string().min(1).max(100), url,
  enabled: z.boolean().default(true),
  credential: credential.default({ type: "none" }),
});
// Slug is immutable: renaming it would silently rename every tool clients rely on.
const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  url: url.optional(),
  enabled: z.boolean().optional(),
  credential: credential.optional(),        // omitted = keep the current credential
});

function credentialColumns(c: z.infer<typeof credential>) {
  return {
    type: c.type,
    header: c.type === "header" ? c.header_name : null,
    encrypted: c.type === "none" ? null : encrypt(c.value),
  };
}

function present(row: ServerRow, isAdmin: boolean) {
  const live = upstreams.snapshot().find((s) => s.id === row.id);
  return {
    id: row.id, slug: row.slug, name: row.name, enabled: row.enabled,
    status: row.enabled ? live?.status ?? "unreachable" : "disabled",
    last_error: live?.last_error ?? null,
    last_checked_at: live?.last_checked_at ?? null,
    tools: live?.tools ?? [],
    // Admin-only details. Note what's missing even for admins: the credential value.
    ...(isAdmin && {
      url: row.url,
      credential: { type: row.credential_type, header_name: row.credential_header, configured: !!row.credential_encrypted },
    }),
  };
}

async function getRow(id: string): Promise<ServerRow | undefined> {
  const { rows } = await pool.query<ServerRow>("SELECT * FROM upstream_servers WHERE id = $1", [id]);
  return rows[0];
}

serversRouter.get("/", ah(async (req, res) => {
  const { rows } = await pool.query<ServerRow>("SELECT * FROM upstream_servers ORDER BY created_at");
  res.json({ servers: rows.map((r) => present(r, req.user!.role === "admin")) });
}));

serversRouter.post("/", requireAdmin, ah(async (req, res) => {
  const body = parseBody(createSchema, req, res);
  if (!body) return;
  const refused = await validateUpstreamUrl(body.url);
  if (refused) return res.status(400).json({ error: `URL not allowed: ${refused}` });
  const cred = credentialColumns(body.credential);
  try {
    const { rows } = await pool.query<ServerRow>(
      `INSERT INTO upstream_servers (slug, name, url, enabled, credential_type, credential_header, credential_encrypted)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [body.slug, body.name, body.url, body.enabled, cred.type, cred.header, cred.encrypted]
    );
    await upstreams.refreshNow(rows[0].id);   // connect right away so status/tools are filled in
    res.status(201).json({ server: present(rows[0], true) });
  } catch (e) {
    if (isUniqueViolation(e)) return res.status(409).json({ error: `Slug "${body.slug}" is already used` });
    throw e;
  }
}));

serversRouter.patch("/:id", requireAdmin, ah(async (req, res) => {
  const body = parseBody(updateSchema, req, res);
  if (!body) return;
  const current = await getRow(req.params.id);
  if (!current) return res.status(404).json({ error: "Server not found" });
  if (body.url) {
    const refused = await validateUpstreamUrl(body.url);
    if (refused) return res.status(400).json({ error: `URL not allowed: ${refused}` });
  }
  const cred = body.credential ? credentialColumns(body.credential) : null;
  const { rows } = await pool.query<ServerRow>(
    `UPDATE upstream_servers SET
        name = COALESCE($2, name), url = COALESCE($3, url), enabled = COALESCE($4, enabled),
        credential_type      = CASE WHEN $5::boolean THEN $6 ELSE credential_type END,
        credential_header    = CASE WHEN $5::boolean THEN $7 ELSE credential_header END,
        credential_encrypted = CASE WHEN $5::boolean THEN $8 ELSE credential_encrypted END,
        updated_at = now()
      WHERE id = $1 RETURNING *`,
    [req.params.id, body.name ?? null, body.url ?? null, body.enabled ?? null,
     cred !== null, cred?.type ?? null, cred?.header ?? null, cred?.encrypted ?? null]
  );
  await upstreams.refreshNow(req.params.id);
  res.json({ server: present(rows[0], true) });
}));

serversRouter.delete("/:id", requireAdmin, ah(async (req, res) => {
  const { rowCount } = await pool.query("DELETE FROM upstream_servers WHERE id = $1", [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "Server not found" });
  await upstreams.refreshNow();
  res.json({ ok: true });
}));

// "Check now" button: re-connect and re-fetch tools immediately.
serversRouter.post("/:id/refresh", requireAdmin, ah(async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: "Server not found" });
  await upstreams.refreshNow(row.id);
  res.json({ server: present(row, true) });
}));
