// The gateway's MCP CLIENT side: one connection per registered upstream server.
//
// - Every few seconds (and right after an admin change) each enabled upstream is
//   checked in parallel: connect if needed, fetch tools/list, record status.
// - The tool list is CACHED. Listing tools for a client never waits on an upstream,
//   so a slow or dead server can't slow down or break tools/list.
// - Each tool is exposed as "<slug>__<tool>". Slugs are unique, so two servers can
//   both have "list" without colliding: notes__list vs todo__list.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError, ToolListChangedNotificationSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import { config } from "./config.js";
import { pool } from "./db.js";
import { decrypt } from "./crypto.js";

export type Status = "connected" | "unreachable" | "disabled";

export type ServerRow = {
  id: string; slug: string; name: string; url: string; enabled: boolean;
  credential_type: "none" | "bearer" | "header"; credential_header: string | null;
  credential_encrypted: string | null; updated_at: Date;
};

type UpstreamState = {
  row: ServerRow;
  client?: Client;
  status: Status;
  tools: Tool[];             // as the upstream reported them (original names)
  lastError?: string;
  lastCheckedAt?: Date;
  refreshing?: Promise<void>; // de-duplicates concurrent refreshes of one server
};

export type ExposedTool = { serverId: string; slug: string; serverName: string; original: string; tool: Tool };

export const SEPARATOR = "__";
const MAX_TOOL_NAME = 64;          // many LLM APIs reject longer tool names
const MAX_DESCRIPTION = 2000;      // upstream text is untrusted; cap what reaches the model

/** "<slug>__<tool>", shortened deterministically with a hash if it would exceed 64 chars. */
export function exposedName(slug: string, tool: string): string {
  const name = `${slug}${SEPARATOR}${tool}`;
  if (name.length <= MAX_TOOL_NAME) return name;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${name.slice(0, MAX_TOOL_NAME - 9)}_${hash}`;
}

/** Errors with a message that is safe and useful to show to the caller. */
export class UpstreamError extends Error {
  constructor(message: string, readonly kind: "unreachable" | "timeout" | "disabled" | "error") { super(message); }
}

const errorMessage = (e: unknown) => {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  return err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(e);
};

class UpstreamManager {
  private states = new Map<string, UpstreamState>();
  private index = new Map<string, ExposedTool>();   // exposed name -> routing info
  private timer?: NodeJS.Timeout;

  start() {
    void this.refreshAll();
    this.timer = setInterval(() => void this.refreshAll(), config.refreshIntervalMs);
  }

  async stop() {
    clearInterval(this.timer);
    await Promise.allSettled([...this.states.values()].map((s) => this.disconnect(s)));
  }

  // ---------- registry sync ----------

  /** Re-read upstream_servers from the DB (another replica or an admin may have changed it). */
  private async syncFromDb() {
    const { rows } = await pool.query<ServerRow>("SELECT * FROM upstream_servers ORDER BY created_at");
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.id);
      const state = this.states.get(row.id);
      if (!state) {
        this.states.set(row.id, { row, status: row.enabled ? "unreachable" : "disabled", tools: [] });
      } else if (state.row.updated_at.getTime() !== row.updated_at.getTime()) {
        // URL, credential or enabled flag changed: drop the old connection, reconnect on refresh.
        await this.disconnect(state);
        state.row = row;
        state.tools = [];
        state.status = row.enabled ? "unreachable" : "disabled";
      }
    }
    for (const [id, state] of this.states) {
      if (!seen.has(id)) { await this.disconnect(state); this.states.delete(id); }
    }
  }

  /** Check every server in parallel. allSettled: one failure never affects the others. */
  async refreshAll() {
    try {
      await this.syncFromDb();
      await Promise.allSettled([...this.states.values()].map((s) => this.refresh(s)));
    } catch (e) {
      console.error("[upstreams] refresh cycle failed:", errorMessage(e));
    }
    this.rebuildIndex();
  }

  /** Called right after an admin adds/edits/enables/removes a server. */
  async refreshNow(serverId?: string) {
    await this.syncFromDb();
    const targets = serverId ? [this.states.get(serverId)].filter(Boolean) as UpstreamState[] : [...this.states.values()];
    await Promise.allSettled(targets.map((s) => this.refresh(s)));
    this.rebuildIndex();
  }

  private refresh(state: UpstreamState): Promise<void> {
    state.refreshing ??= this.doRefresh(state).finally(() => { state.refreshing = undefined; });
    return state.refreshing;
  }

  private async doRefresh(state: UpstreamState) {
    if (!state.row.enabled) {
      await this.disconnect(state);
      state.status = "disabled";
      state.tools = [];
      state.lastError = undefined;
      return;
    }
    try {
      const client = state.client ?? (await this.connect(state));
      state.tools = await this.listAllTools(client);
      if (state.status !== "connected") console.log(`[upstreams] ${state.row.slug}: connected (${state.tools.length} tools)`);
      state.status = "connected";
      state.lastError = undefined;
    } catch (e) {
      if (state.status !== "unreachable" || state.lastError !== errorMessage(e)) {
        console.warn(`[upstreams] ${state.row.slug}: unreachable: ${errorMessage(e)}`);
      }
      state.status = "unreachable";
      state.lastError = errorMessage(e);
      await this.disconnect(state);
    }
    state.lastCheckedAt = new Date();
  }

  // ---------- connections ----------

  /** Headers for this upstream. The CLIENT's API key is never forwarded: only the
   *  credential the admin stored for this server, decrypted in memory, is sent. */
  private upstreamHeaders(row: ServerRow): Record<string, string> {
    if (row.credential_type === "none" || !row.credential_encrypted) return {};
    const secret = decrypt(row.credential_encrypted);
    return row.credential_type === "bearer"
      ? { Authorization: `Bearer ${secret}` }
      : { [row.credential_header!]: secret };
  }

  private async connect(state: UpstreamState): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(state.row.url), {
      requestInit: { headers: this.upstreamHeaders(state.row) },
      // Don't keep retrying a broken server-to-client stream in the background;
      // the periodic refresh decides when to reconnect.
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
    const client = new Client({ name: "mcp-gateway", version: "0.1.0" }, { capabilities: {} });
    client.onerror = () => {}; // transport errors surface through the requests that hit them
    try {
      await client.connect(transport, { timeout: config.timeouts.connectMs });
    } catch (e) {
      await client.close().catch(() => {});
      throw e;
    }
    // If an upstream announces that its tools changed, re-fetch right away.
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      await this.refresh(state);
      this.rebuildIndex();
    });
    state.client = client;
    return client;
  }

  private async disconnect(state: UpstreamState) {
    const client = state.client;
    state.client = undefined;
    await client?.close().catch(() => {});
  }

  private async listAllTools(client: Client): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {   // tools/list can be paginated
      const page = await client.listTools(cursor ? { cursor } : {}, { timeout: config.timeouts.listMs });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor && tools.length < 1000);
    return tools;
  }

  // ---------- what clients see ----------

  private rebuildIndex() {
    const index = new Map<string, ExposedTool>();
    for (const s of this.states.values()) {
      if (!s.row.enabled) continue;
      for (const tool of s.tools) {
        index.set(exposedName(s.row.slug, tool.name), {
          serverId: s.row.id, slug: s.row.slug, serverName: s.row.name, original: tool.name, tool,
        });
      }
    }
    this.index = index;
  }

  /** Tools of every enabled AND currently connected server, renamed and labelled. */
  listExposedTools(): { name: string; entry: ExposedTool; status: Status }[] {
    return [...this.index.entries()]
      .map(([name, entry]) => ({ name, entry, status: this.states.get(entry.serverId)?.status ?? "unreachable" }))
      .filter((t) => t.status === "connected");
  }

  resolve(name: string): ExposedTool | undefined {
    return this.index.get(name);
  }

  /** Forward one tool call to its upstream, with a timeout. */
  async call(entry: ExposedTool, args: Record<string, unknown> | undefined) {
    const state = this.states.get(entry.serverId);
    if (!state || !state.row.enabled) throw new UpstreamError(`Server "${entry.slug}" is disabled`, "disabled");

    // Not connected right now? Try once immediately instead of waiting for the next cycle.
    if (!state.client) {
      await this.refresh(state);
      this.rebuildIndex();
      if (!state.client) {
        throw new UpstreamError(`Server "${entry.slug}" is unreachable: ${state.lastError ?? "no connection"}`, "unreachable");
      }
    }

    try {
      return await state.client.callTool(
        { name: entry.original, arguments: args ?? {} },
        undefined,
        { timeout: config.timeouts.callMs }
      );
    } catch (e) {
      if (e instanceof McpError && e.code === ErrorCode.RequestTimeout) {
        // Slow is not dead: keep the connection, report the timeout.
        throw new UpstreamError(`Server "${entry.slug}" did not answer within ${config.timeouts.callMs / 1000}s`, "timeout");
      }
      if (e instanceof McpError) {
        // The upstream answered with a protocol error (e.g. invalid arguments). It's alive.
        throw new UpstreamError(`Server "${entry.slug}" returned an error: ${e.message}`, "error");
      }
      // Network-level failure: mark it unreachable now, so its tools disappear immediately.
      state.status = "unreachable";
      state.lastError = errorMessage(e);
      state.lastCheckedAt = new Date();
      await this.disconnect(state);
      this.rebuildIndex();
      throw new UpstreamError(`Server "${entry.slug}" is unreachable: ${state.lastError}`, "unreachable");
    }
  }

  /** Status of every server, for the dashboard. Never includes credentials. */
  snapshot() {
    return [...this.states.values()].map((s) => ({
      id: s.row.id,
      status: s.status,
      last_error: s.lastError ?? null,
      last_checked_at: s.lastCheckedAt ?? null,
      tools: s.row.enabled
        ? s.tools.map((t) => ({ name: exposedName(s.row.slug, t.name), original_name: t.name, description: t.description ?? "" }))
        : [],
    }));
  }
}

export const upstreams = new UpstreamManager();

/** The version of a tool a client sees: prefixed name, server label, capped description. */
export function presentTool(name: string, entry: ExposedTool): Tool {
  const desc = (entry.tool.description ?? "").slice(0, MAX_DESCRIPTION);
  return {
    ...entry.tool,
    name,
    title: entry.tool.title ? `${entry.tool.title} (${entry.serverName})` : undefined,
    description: `[${entry.serverName}] ${desc}`,
  };
}
