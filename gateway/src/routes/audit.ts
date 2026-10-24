// Audit log viewer. Admins see every entry; members see only their own.
import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireSession } from "../auth.js";
import { ah } from "../http.js";

export const auditRouter = Router();
auditRouter.use(requireSession);

const query = z.object({
  user_id: z.string().uuid().optional(),
  server: z.string().max(50).optional(),
  outcome: z.enum(["success", "error", "timeout", "unreachable", "rejected"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before_id: z.coerce.number().int().optional(),   // pagination: entries older than this id
});

auditRouter.get("/", ah(async (req, res) => {
  const q = query.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: "Invalid query" });
  const { user_id, server, outcome, limit, before_id } = q.data;

  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => { params.push(value); where.push(sql.replace("?", `$${params.length}`)); };

  if (req.user!.role !== "admin") add("user_id = ?", req.user!.id);
  else if (user_id) add("user_id = ?", user_id);
  if (server) add("server_slug = ?", server);
  if (outcome) add("outcome = ?", outcome);
  if (before_id) add("id < ?", before_id);
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT id, ts, user_id, user_email, api_key_id, source, server_slug, tool, duration_ms, outcome, error
       FROM audit_log ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY id DESC LIMIT $${params.length}`,
    params
  );
  res.json({ entries: rows });
}));
