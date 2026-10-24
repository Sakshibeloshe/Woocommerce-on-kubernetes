// Team management (admins only): invite, change role, disable, delete.
import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { config } from "../config.js";
import { randomToken, sha256 } from "../crypto.js";
import { requireAdmin, requireSession } from "../auth.js";
import { ah, isUniqueViolation, parseBody } from "../http.js";
import { issueKey } from "./keys.js";

export const usersRouter = Router();
usersRouter.use(requireSession, requireAdmin);

const INVITE_DAYS = 7;

usersRouter.get("/", ah(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT u.id, u.email, u.name, u.role, u.disabled, u.created_at,
           (u.password_hash IS NULL) AS invite_pending,
           count(k.id) FILTER (WHERE k.revoked_at IS NULL) AS active_keys
      FROM users u LEFT JOIN api_keys k ON k.user_id = u.id
     GROUP BY u.id ORDER BY u.created_at`);
  res.json({ users: rows.map((r) => ({ ...r, active_keys: Number(r.active_keys) })) });
}));

// Invite: creates the user without a password and returns a one-time link.
usersRouter.post("/", ah(async (req, res) => {
  const body = parseBody(z.object({
    email: z.string().email(),
    name: z.string().max(100).default(""),
    role: z.enum(["admin", "member"]).default("member"),
  }), req, res);
  if (!body) return;
  const token = randomToken(24);
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (email, name, role, invite_token_hash, invite_expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '${INVITE_DAYS} days')
       RETURNING id, email, name, role, created_at`,
      [body.email.toLowerCase(), body.name, body.role, sha256(token)]
    );
    // The token is shown once; only its hash is stored.
    res.status(201).json({
      user: rows[0],
      invite_token: token,
      invite_url: `${config.publicUrl}/invite?token=${token}`,
      expires_in_days: INVITE_DAYS,
    });
  } catch (e) {
    if (isUniqueViolation(e)) return res.status(409).json({ error: "A user with this email already exists" });
    throw e;
  }
}));

// Would this change leave the team without an active admin?
async function wouldRemoveLastAdmin(userId: string) {
  const { rows } = await pool.query(
    "SELECT count(*) AS n FROM users WHERE role = 'admin' AND disabled = false AND password_hash IS NOT NULL AND id <> $1",
    [userId]
  );
  return Number(rows[0].n) === 0;
}

usersRouter.patch("/:id", ah(async (req, res) => {
  const body = parseBody(z.object({
    name: z.string().max(100).optional(),
    role: z.enum(["admin", "member"]).optional(),
    disabled: z.boolean().optional(),
  }), req, res);
  if (!body) return;
  if ((body.role === "member" || body.disabled) && (await wouldRemoveLastAdmin(req.params.id))) {
    return res.status(400).json({ error: "The team must keep at least one active admin" });
  }
  const { rows } = await pool.query(
    `UPDATE users SET name = COALESCE($2, name), role = COALESCE($3, role), disabled = COALESCE($4, disabled)
      WHERE id = $1 RETURNING id, email, name, role, disabled`,
    [req.params.id, body.name ?? null, body.role ?? null, body.disabled ?? null]
  );
  if (!rows[0]) return res.status(404).json({ error: "User not found" });
  res.json({ user: rows[0] });
}));

usersRouter.delete("/:id", ah(async (req, res) => {
  if (req.params.id === req.user!.id) return res.status(400).json({ error: "You can't delete yourself" });
  if (await wouldRemoveLastAdmin(req.params.id)) {
    return res.status(400).json({ error: "The team must keep at least one active admin" });
  }
  const { rowCount } = await pool.query("DELETE FROM users WHERE id = $1", [req.params.id]); // keys cascade
  if (!rowCount) return res.status(404).json({ error: "User not found" });
  res.json({ ok: true });
}));

// An admin can see and issue keys for a team member.
usersRouter.get("/:id/keys", ah(async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, name, prefix, created_at, last_used_at, revoked_at FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC",
    [req.params.id]
  );
  res.json({ keys: rows });
}));

usersRouter.post("/:id/keys", ah(async (req, res) => {
  const body = parseBody(z.object({ name: z.string().max(100).default("") }), req, res);
  if (!body) return;
  const { rows } = await pool.query("SELECT id FROM users WHERE id = $1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "User not found" });
  res.status(201).json(await issueKey(req.params.id, body.name));
}));
