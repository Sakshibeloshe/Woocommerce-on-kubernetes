// First-start setup: the first admin and the initial upstream servers.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { config } from "./config.js";
import { pool } from "./db.js";
import { encrypt, hashPassword } from "./crypto.js";

/** Create the first admin from ADMIN_EMAIL / ADMIN_PASSWORD, only if there are no users. */
export async function bootstrapAdmin() {
  const { email, password } = config.bootstrapAdmin;
  if (!email || !password) return;
  const { rows } = await pool.query(
    `INSERT INTO users (email, name, role, password_hash)
     SELECT $1, 'Admin', 'admin', $2 WHERE NOT EXISTS (SELECT 1 FROM users)
     RETURNING email`,
    [email.toLowerCase(), await hashPassword(password)]
  );
  if (rows[0]) console.log(`[seed] created first admin ${rows[0].email}`);
}

// The seed file lists servers; credential VALUES are not in the file but in env vars
// (from a Secret), referenced by name: { "type": "bearer", "valueFromEnv": "NOTES_TOKEN" }.
const seedFile = z.array(z.object({
  slug: z.string(), name: z.string(), url: z.string(),
  credential: z.object({
    type: z.enum(["bearer", "header"]),
    header_name: z.string().optional(),
    valueFromEnv: z.string(),
  }).optional(),
}));

/** Register the initial upstream servers ONCE. After that the registry belongs to the
 *  admins: a server they delete must not come back on the next restart. */
export async function seedServers() {
  if (!config.seedServersFile) return;
  const done = await pool.query("SELECT 1 FROM gateway_meta WHERE key = 'servers_seeded'");
  if (done.rowCount) return;

  const servers = seedFile.parse(JSON.parse(readFileSync(config.seedServersFile, "utf8")));
  for (const s of servers) {
    let type = "none", header: string | null = null, encrypted: string | null = null;
    if (s.credential) {
      const value = process.env[s.credential.valueFromEnv];
      if (!value) throw new Error(`Seed server ${s.slug}: env var ${s.credential.valueFromEnv} is not set`);
      type = s.credential.type;
      header = s.credential.header_name ?? null;
      encrypted = encrypt(value);
    }
    await pool.query(
      `INSERT INTO upstream_servers (slug, name, url, credential_type, credential_header, credential_encrypted)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (slug) DO NOTHING`,
      [s.slug, s.name, s.url, type, header, encrypted]
    );
    console.log(`[seed] registered upstream "${s.slug}" -> ${s.url}`);
  }
  await pool.query("INSERT INTO gateway_meta (key, value) VALUES ('servers_seeded', now()::text) ON CONFLICT DO NOTHING");
}
