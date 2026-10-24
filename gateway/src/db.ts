import pg from "pg";

// A pool keeps a few connections open and lends them out per query.
export const pool = new pg.Pool({ max: 10 });

// The schema is applied on every start. Every statement is "IF NOT EXISTS",
// so this is safe to repeat and works with several gateway replicas starting at once.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text NOT NULL UNIQUE,
  name               text NOT NULL DEFAULT '',
  role               text NOT NULL CHECK (role IN ('admin', 'member')),
  password_hash      text,                 -- NULL until the invite is accepted
  invite_token_hash  text UNIQUE,          -- sha256 of the one-time invite token
  invite_expires_at  timestamptz,
  disabled           boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL DEFAULT '',
  prefix        text NOT NULL,             -- first characters, safe to display
  key_hash      text NOT NULL UNIQUE,      -- sha256 of the full key; the key itself is never stored
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz                -- revocation is a flag (timestamp), the row stays for the audit trail
);

CREATE TABLE IF NOT EXISTS upstream_servers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                  text NOT NULL UNIQUE,   -- tool prefix: <slug>__<tool>
  name                  text NOT NULL,
  url                   text NOT NULL,
  enabled               boolean NOT NULL DEFAULT true,
  credential_type       text NOT NULL DEFAULT 'none' CHECK (credential_type IN ('none', 'bearer', 'header')),
  credential_header     text,                   -- header name when credential_type = 'header'
  credential_encrypted  text,                   -- AES-256-GCM, never returned by the API
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           bigserial PRIMARY KEY,
  ts           timestamptz NOT NULL DEFAULT now(),
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  user_email   text,                      -- copied, so history survives user deletion
  api_key_id   uuid,
  source       text NOT NULL,             -- 'mcp' (external client) or 'chat' (dashboard agent)
  server_id    uuid,
  server_slug  text,
  tool         text,
  duration_ms  integer NOT NULL DEFAULT 0,
  outcome      text NOT NULL,             -- success | error | timeout | unreachable | rejected
  error        text
);
CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS audit_log_user_idx ON audit_log (user_id, ts DESC);

CREATE TABLE IF NOT EXISTS gateway_meta (
  key    text PRIMARY KEY,
  value  text NOT NULL
);
`;

export async function waitForDb(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (e) {
      if (attempt >= 30) throw e;
      console.log(`[db] waiting for Postgres (attempt ${attempt}): ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export async function migrate(): Promise<void> {
  // An advisory lock makes concurrent replicas apply the schema one at a time.
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(424242)");
    await client.query(SCHEMA);
  } finally {
    await client.query("SELECT pg_advisory_unlock(424242)").catch(() => {});
    client.release();
  }
}
