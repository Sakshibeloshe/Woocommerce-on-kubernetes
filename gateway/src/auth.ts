// Two ways to prove who you are:
//   1. Dashboard: email + password -> signed session cookie (JWT).
//   2. MCP clients: "Authorization: Bearer mcpgw_..." API key.
import type { NextFunction, Request, Response } from "express";
import { SignJWT, jwtVerify } from "jose";
import { config } from "./config.js";
import { pool } from "./db.js";
import { API_KEY_PREFIX, sha256 } from "./crypto.js";

export type Role = "admin" | "member";
export type User = { id: string; email: string; name: string; role: Role };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { user?: User }
  }
}

export const SESSION_COOKIE = "gw_session";
const SESSION_HOURS = 12;

// ---------- dashboard sessions ----------

export async function startSession(res: Response, user: User) {
  const token = await new SignJWT({ sub: user.id })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .sign(config.sessionSecret);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,            // JavaScript in the page can't read it (limits XSS damage)
    sameSite: "lax",           // not sent on cross-site POSTs (CSRF protection)
    secure: config.cookieSecure,
    maxAge: SESSION_HOURS * 3600 * 1000,
    path: "/",
  });
}

export function endSession(res: Response) {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

async function loadUser(id: string): Promise<User | null> {
  const { rows } = await pool.query(
    "SELECT id, email, name, role FROM users WHERE id = $1 AND disabled = false AND password_hash IS NOT NULL",
    [id]
  );
  return rows[0] ?? null;
}

/** Middleware: require a valid session cookie. The user is re-read from the DB on
 *  every request, so disabling or deleting a user takes effect immediately. */
export async function requireSession(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return res.status(401).json({ error: "Not logged in" });
    const { payload } = await jwtVerify(token, config.sessionSecret);
    const user = await loadUser(String(payload.sub));
    if (!user) return res.status(401).json({ error: "Session no longer valid" });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Session expired or invalid" });
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admins only" });
  next();
}

// ---------- API keys (MCP endpoint) ----------

export type ApiKeyAuth =
  | { ok: true; user: User; keyId: string }
  | { ok: false; reason: string; user?: User; keyId?: string };

export async function authenticateApiKey(header: string | undefined): Promise<ApiKeyAuth> {
  const key = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!key || !key.startsWith(API_KEY_PREFIX)) return { ok: false, reason: "Missing or malformed API key" };

  // Look up by hash: the database never sees (or stores) the key itself.
  const { rows } = await pool.query(
    `SELECT k.id AS key_id, k.revoked_at, u.id, u.email, u.name, u.role, u.disabled
       FROM api_keys k JOIN users u ON u.id = k.user_id
      WHERE k.key_hash = $1`,
    [sha256(key)]
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: "Unknown API key" };

  const user: User = { id: row.id, email: row.email, name: row.name, role: row.role };
  if (row.revoked_at) return { ok: false, reason: "API key has been revoked", user, keyId: row.key_id };
  if (row.disabled) return { ok: false, reason: "User is disabled", user, keyId: row.key_id };

  pool.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [row.key_id]).catch(() => {});
  return { ok: true, user, keyId: row.key_id };
}
