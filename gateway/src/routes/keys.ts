// Every user manages their own API keys. Admins can also revoke anyone's key.
import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { newApiKey } from "../crypto.js";
import { requireSession } from "../auth.js";
import { ah, parseBody } from "../http.js";

export const keysRouter = Router();
keysRouter.use(requireSession);

export async function issueKey(userId: string, name: string) {
  const { key, prefix, hash } = newApiKey();
  const { rows } = await pool.query(
    "INSERT INTO api_keys (user_id, name, prefix, key_hash) VALUES ($1, $2, $3, $4) RETURNING id, name, prefix, created_at",
    [userId, name, prefix, hash]
  );
  // "key" is returned exactly once, here. After this response it can't be recovered.
  return { ...rows[0], key };
}

keysRouter.get("/", ah(async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, name, prefix, created_at, last_used_at, revoked_at FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC",
    [req.user!.id]
  );
  res.json({ keys: rows });
}));

keysRouter.post("/", ah(async (req, res) => {
  const body = parseBody(z.object({ name: z.string().max(100).default("") }), req, res);
  if (!body) return;
  res.status(201).json(await issueKey(req.user!.id, body.name));
}));

// Revoke = set revoked_at. The very next MCP request with this key is rejected,
// because every request looks the key up in the database.
keysRouter.delete("/:id", ah(async (req, res) => {
  const isAdmin = req.user!.role === "admin";
  const { rows } = await pool.query(
    `UPDATE api_keys SET revoked_at = now()
      WHERE id = $1 AND revoked_at IS NULL AND ($2 OR user_id = $3)
      RETURNING id, prefix, revoked_at`,
    [req.params.id, isAdmin, req.user!.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Key not found or already revoked" });
  res.json({ key: rows[0] });
}));
