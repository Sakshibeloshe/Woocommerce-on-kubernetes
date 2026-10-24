// Login, logout, "who am I", and accepting an invite.
import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { hashPassword, sha256, verifyPassword } from "../crypto.js";
import { endSession, requireSession, startSession, type User } from "../auth.js";
import { ah, parseBody } from "../http.js";

export const authRouter = Router();

// A real scrypt hash of a random string, used to spend the same time on unknown emails.
const DUMMY_HASH = await hashPassword(Math.random().toString(36));

const password = z.string().min(10, "Password must be at least 10 characters").max(200);

authRouter.post("/login", ah(async (req, res) => {
  const body = parseBody(z.object({ email: z.string().email(), password: z.string() }), req, res);
  if (!body) return;
  const { rows } = await pool.query(
    "SELECT id, email, name, role, password_hash FROM users WHERE lower(email) = lower($1) AND disabled = false",
    [body.email]
  );
  const row = rows[0];
  // Same error AND same work for "no such user" and "wrong password", so emails can't be
  // probed by message or by response time (a dummy hash is checked when the user doesn't exist).
  const valid = await verifyPassword(body.password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !valid) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  const user: User = { id: row.id, email: row.email, name: row.name, role: row.role };
  await startSession(res, user);
  res.json({ user });
}));

authRouter.post("/logout", (_req, res) => {
  endSession(res);
  res.json({ ok: true });
});

authRouter.get("/me", requireSession, (req, res) => res.json({ user: req.user }));

// An invited user sets their password with the one-time token from the invite link.
authRouter.post("/accept-invite", ah(async (req, res) => {
  const body = parseBody(z.object({ token: z.string().min(10), password }), req, res);
  if (!body) return;
  const { rows } = await pool.query(
    `UPDATE users
        SET password_hash = $1, invite_token_hash = NULL, invite_expires_at = NULL
      WHERE invite_token_hash = $2 AND invite_expires_at > now() AND disabled = false
      RETURNING id, email, name, role`,
    [await hashPassword(body.password), sha256(body.token)]
  );
  if (!rows[0]) return res.status(400).json({ error: "Invite link is invalid or expired" });
  await startSession(res, rows[0]);
  res.json({ user: rows[0] });
}));
