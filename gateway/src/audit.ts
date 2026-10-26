import { pool } from "./db.js";

export type Outcome = "success" | "error" | "timeout" | "unreachable" | "rejected";

export type AuditEntry = {
  userId?: string | null;
  userEmail?: string | null;
  apiKeyId?: string | null;
  source: "mcp" | "chat" | "dashboard";
  serverId?: string | null;
  serverSlug?: string | null;
  tool?: string | null;
  durationMs: number;
  outcome: Outcome;
  error?: string | null;
};

/** Write one audit row. Never throws: a logging failure must not break a tool call. */
export async function audit(e: AuditEntry): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_log (user_id, user_email, api_key_id, source, server_id, server_slug, tool, duration_ms, outcome, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        e.userId ?? null, e.userEmail ?? null, e.apiKeyId ?? null, e.source,
        e.serverId ?? null, e.serverSlug ?? null, e.tool ?? null,
        Math.round(e.durationMs), e.outcome, e.error?.slice(0, 1000) ?? null,
      ]
    );
  } catch (err) {
    console.error("[audit] failed to write entry:", (err as Error).message, e);
  }
}
