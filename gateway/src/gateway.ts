// The heart of the gateway. Both entry points use exactly these two functions:
//   - external MCP clients (POST /mcp, authenticated by API key)
//   - the dashboard chat agent (authenticated by session, later phase)
// so both get the same tools, the same routing and the same audit trail.
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { User } from "./auth.js";
import { audit, type Outcome } from "./audit.js";
import { presentTool, upstreams, UpstreamError } from "./upstreams.js";

export type Caller = { user: User; apiKeyId: string | null; source: "mcp" | "chat" };

const errorResult = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });

/** Union of the tools of every enabled, connected upstream. Served from cache: instant. */
export function listTools(_caller: Caller): Tool[] {
  return upstreams.listExposedTools().map(({ name, entry }) => presentTool(name, entry));
}

/** Route one call to the right upstream and audit it, whatever happens. */
export async function callTool(caller: Caller, name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const started = Date.now();
  const entry = upstreams.resolve(name);
  const base = {
    userId: caller.user.id, userEmail: caller.user.email, apiKeyId: caller.apiKeyId, source: caller.source,
    serverId: entry?.serverId, serverSlug: entry?.slug, tool: entry?.original ?? name,
  };

  if (!entry) {
    await audit({ ...base, durationMs: Date.now() - started, outcome: "rejected", error: "Unknown or unavailable tool" });
    return errorResult(`Unknown or unavailable tool: ${name}`);
  }

  try {
    const result = (await upstreams.call(entry, args)) as CallToolResult;
    // isError = the tool ran but reported a failure (e.g. "WooCommerce 404: Invalid ID").
    const failed = result.isError === true;
    await audit({
      ...base, durationMs: Date.now() - started, outcome: failed ? "error" : "success",
      error: failed ? firstText(result) : null,
    });
    return result;
  } catch (e) {
    const kind = e instanceof UpstreamError ? e.kind : "error";
    const outcome: Outcome = kind === "disabled" ? "rejected" : kind;
    const message = e instanceof UpstreamError ? e.message : `Gateway error: ${(e as Error).message}`;
    await audit({ ...base, durationMs: Date.now() - started, outcome, error: message });
    return errorResult(message);
  }
}

function firstText(result: CallToolResult): string | null {
  const c = result.content?.find((x) => x.type === "text");
  return c && "text" in c ? String(c.text).slice(0, 500) : null;
}
