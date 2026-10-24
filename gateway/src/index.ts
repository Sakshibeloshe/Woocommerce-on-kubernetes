import express from "express";
import cookieParser from "cookie-parser";
import { config } from "./config.js";
import { migrate, pool, waitForDb } from "./db.js";
import { bootstrapAdmin, seedServers } from "./seed.js";
import { upstreams } from "./upstreams.js";
import { mcpRouter } from "./mcp.js";
import { authRouter } from "./routes/auth.js";
import { usersRouter } from "./routes/users.js";
import { keysRouter } from "./routes/keys.js";
import { serversRouter } from "./routes/servers.js";
import { auditRouter } from "./routes/audit.js";
import { chatRouter } from "./routes/chat.js";
import { loginLimiter, mcpAuthFailureLimiter, mcpPerKeyLimiter } from "./ratelimit.js";

await waitForDb();
await migrate();
await bootstrapAdmin();
await seedServers();
upstreams.start();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);                 // behind Traefik: use X-Forwarded-* for req.ip etc.
app.use(express.json({ limit: "1mb" }));    // cap request size (cheap DoS protection)
app.use(cookieParser());

// Liveness: the process is up. Readiness: it can also reach its database.
app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
app.get("/readyz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ready" });
  } catch {
    res.status(503).json({ status: "database unavailable" });
  }
});

app.use("/mcp", mcpAuthFailureLimiter, mcpPerKeyLimiter, mcpRouter);   // MCP clients (API key)
app.use("/api/auth/login", loginLimiter);
app.use("/api/auth/accept-invite", loginLimiter);
app.use("/api/auth", authRouter);           // dashboard (session cookie) ...
app.use("/api/users", usersRouter);
app.use("/api/keys", keysRouter);
app.use("/api/servers", serversRouter);
app.use("/api/audit", auditRouter);
app.use("/api/chat", chatRouter);

// Last-resort error handler: log details, return nothing internal to the client.
app.use((err: Error & { type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON" });
  if (err.type === "entity.too.large") return res.status(413).json({ error: "Request too large" });
  console.error("[http] unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

const server = app.listen(config.port, "0.0.0.0", () => console.log(`[gateway] listening on :${config.port}`));

// Kubernetes sends SIGTERM before stopping a pod: finish in-flight requests, then exit.
process.on("SIGTERM", async () => {
  console.log("[gateway] SIGTERM: shutting down");
  server.close();
  await upstreams.stop();
  await pool.end();
  process.exit(0);
});
