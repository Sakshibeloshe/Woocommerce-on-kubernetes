// Notes MCP server: a shared notebook the team (and the chat agent) can write to.
// Same skeleton as mcp-woocommerce, plus two things:
//   1. A bearer token is REQUIRED (demonstrates the gateway's upstream-credential feature).
//   2. Notes are saved to a JSON file, which lives on a Kubernetes volume.
import express from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const TOKEN = process.env.NOTES_API_TOKEN;
const FILE = process.env.NOTES_FILE ?? "./data/notes.json";
if (!TOKEN) throw new Error("NOTES_API_TOKEN must be set");

// ---------- storage ----------

type Note = { id: string; title: string; content: string; tags: string[]; created_at: string };

function load(): Note[] {
  try { return JSON.parse(readFileSync(FILE, "utf8")); } catch { return []; }
}

let notes: Note[] = load();

function save() {
  // Write to a temp file, then rename: a crash mid-write can't leave a half-written file.
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(notes, null, 2));
  renameSync(`${FILE}.tmp`, FILE);
}

// ---------- helpers ----------

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

const fail = (message: string) => ({
  isError: true,
  content: [{ type: "text" as const, text: message }],
});

// ---------- tools ----------

function buildServer() {
  const server = new McpServer({ name: "notes-mcp", version: "1.0.0" });

  server.registerTool(
    "create_note",
    {
      title: "Create note",
      description: "Save a note to the team notebook (for example a summary of today's orders).",
      inputSchema: {
        title: z.string().min(1).max(200),
        content: z.string().min(1).max(10_000),
        tags: z.array(z.string()).max(10).default([]),
      },
    },
    async ({ title, content, tags }) => {
      const note: Note = { id: randomUUID(), title, content, tags, created_at: new Date().toISOString() };
      notes.push(note);
      save();
      return ok(note);
    }
  );

  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description: "List notes, newest first. Optionally filter by text (title/content) or tag.",
      inputSchema: {
        search: z.string().optional(),
        tag: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ search, tag, limit }) => {
      const q = search?.toLowerCase();
      const result = notes
        .filter((n) => !q || n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q))
        .filter((n) => !tag || n.tags.includes(tag))
        .slice(-limit)
        .reverse();
      return ok({ count: result.length, notes: result });
    }
  );

  server.registerTool(
    "delete_note",
    {
      title: "Delete note",
      description: "Delete a note by its id.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const before = notes.length;
      notes = notes.filter((n) => n.id !== id);
      if (notes.length === before) return fail(`No note with id ${id}`);
      save();
      return ok({ deleted: id });
    }
  );

  return server;
}

// ---------- HTTP layer ----------

const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

// Every /mcp request must carry "Authorization: Bearer <token>".
// timingSafeEqual compares in constant time, so response timing can't leak the token.
function requireToken(req: express.Request, res: express.Response, next: express.NextFunction) {
  const given = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /, ""));
  const expected = Buffer.from(TOKEN!);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    res.status(401).set("WWW-Authenticate", "Bearer").json({
      jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null,
    });
    return;
  }
  next();
}

app.post("/mcp", requireToken, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("MCP request failed:", e);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  }
});

const notAllowed = (_req: express.Request, res: express.Response) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
app.get("/mcp", notAllowed);
app.delete("/mcp", notAllowed);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, "0.0.0.0", () => console.log(`Notes MCP server on :${port}/mcp (${notes.length} notes loaded)`));
