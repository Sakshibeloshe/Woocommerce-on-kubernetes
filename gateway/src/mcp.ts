// The gateway's MCP SERVER side: POST /mcp, Streamable HTTP, stateless.
// Clients (Claude Code, Cursor, Inspector) configure ONE url + their API key.
import type { Request, Response, Router } from "express";
import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { authenticateApiKey } from "./auth.js";
import { audit } from "./audit.js";
import { callTool, listTools, type Caller } from "./gateway.js";
import { upstreams } from "./upstreams.js";

export const mcpRouter: Router = express.Router();

// A low-level MCP Server (instead of McpServer) because our tool list is dynamic:
// it is whatever the upstreams offer right now, with their JSON schemas passed through.
function buildServer(caller: Caller) {
  const server = new Server(
    { name: "mcp-gateway", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools(caller) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    callTool(caller, req.params.name, req.params.arguments as Record<string, unknown> | undefined)
  );
  return server;
}

/** tools/call requests inside a (possibly batched) JSON-RPC body, for auditing rejections. */
function toolCallsIn(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages
    .filter((m) => m && typeof m === "object" && (m as { method?: string }).method === "tools/call")
    .map((m) => String((m as { params?: { name?: string } }).params?.name ?? "?"));
}

mcpRouter.post("/", async (req: Request, res: Response) => {
  const auth = await authenticateApiKey(req.headers.authorization);

  if (!auth.ok) {
    // A rejected tool call still goes into the audit log, attributed to the key's
    // owner when the key is known (e.g. revoked).
    for (const name of toolCallsIn(req.body)) {
      const entry = upstreams.resolve(name);
      await audit({
        userId: auth.user?.id, userEmail: auth.user?.email, apiKeyId: auth.keyId, source: "mcp",
        serverId: entry?.serverId, serverSlug: entry?.slug, tool: entry?.original ?? name,
        durationMs: 0, outcome: "rejected", error: auth.reason,
      });
    }
    res.status(401)
      .set("WWW-Authenticate", 'Bearer realm="mcp-gateway"')
      .json({ jsonrpc: "2.0", error: { code: -32001, message: auth.reason }, id: (req.body as { id?: unknown })?.id ?? null });
    return;
  }

  // Stateless: a fresh server + transport per request. Nothing about the client is kept
  // in memory between requests, so any gateway replica can serve any request.
  const server = buildServer({ user: auth.user, apiKeyId: auth.keyId, source: "mcp" });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[mcp] request failed:", e);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  }
});

// Stateless mode: no server-initiated stream (GET) and no sessions to delete (DELETE).
const notAllowed = (_req: Request, res: Response) =>
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
mcpRouter.get("/", notAllowed);
mcpRouter.delete("/", notAllowed);
