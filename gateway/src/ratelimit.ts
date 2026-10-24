// Rate limits (in memory, per gateway replica; use a shared store such as Redis when
// running many replicas and you need exact global limits).
import type { Request } from "express";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { createHash } from "node:crypto";

const json = (message: string) => ({ error: message });
const ip = (req: Request) => ipKeyGenerator(req.ip ?? "unknown");

/** Password guessing: 10 attempts per 15 minutes per (IP, email). Successful logins don't count. */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => `${ip(req)}|${String(req.body?.email ?? "").toLowerCase()}`,
  message: json("Too many login attempts. Try again in 15 minutes."),
});

/** API-key guessing on /mcp: 20 failed (401) requests per minute per IP. */
export const mcpAuthFailureLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  skipSuccessfulRequests: true,          // only failed (4xx/5xx) requests count
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: ip,
  message: { jsonrpc: "2.0", error: { code: -32029, message: "Too many failed authentication attempts" }, id: null },
});

/** Fair use per API key: 300 MCP requests per minute. Keyed by a hash, never the key itself. */
export const mcpPerKeyLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => createHash("sha256").update(req.headers.authorization ?? ip(req)).digest("hex"),
  message: { jsonrpc: "2.0", error: { code: -32029, message: "Rate limit exceeded for this API key" }, id: null },
});

/** The chat calls a (possibly paid or slow) LLM: 20 messages per minute per user. */
export const chatLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? ip(req),
  message: json("Too many chat messages, slow down a little."),
});
