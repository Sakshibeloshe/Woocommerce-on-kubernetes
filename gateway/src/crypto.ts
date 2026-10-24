import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { config } from "./config.js";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Random URL-safe token (invite tokens, API keys). */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

// ---------- passwords: slow, salted hash (scrypt) ----------
// Passwords are short and guessable, so the hash must be deliberately expensive
// to brute-force. scrypt is built into Node (no native dependency like bcrypt).

const SCRYPT = { N: 16384, r: 8, p: 1 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scryptAsync(password, Buffer.from(saltB64, "base64"), expected.length, SCRYPT);
  return timingSafeEqual(actual, expected);
}

// ---------- API keys: fast hash (SHA-256) ----------
// A key is 32 random bytes (256 bits). Nobody can guess that, so a slow hash adds
// nothing; SHA-256 lets us look a key up by its hash in one indexed query.

export const API_KEY_PREFIX = "mcpgw_";

export function newApiKey() {
  const key = API_KEY_PREFIX + randomToken(32);
  return { key, prefix: key.slice(0, API_KEY_PREFIX.length + 6), hash: sha256(key) };
}

// ---------- upstream credentials: reversible encryption (AES-256-GCM) ----------
// Unlike passwords, the gateway must get these back to send them upstream, so they
// are encrypted (not hashed). The key comes from a Kubernetes Secret, so a database
// dump alone is useless. GCM also detects tampering (the auth tag).

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.encryptionKey, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64")}`;
}

export function decrypt(blob: string): string {
  const raw = Buffer.from(blob.replace(/^v1:/, ""), "base64");
  const decipher = createDecipheriv("aes-256-gcm", config.encryptionKey, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}
