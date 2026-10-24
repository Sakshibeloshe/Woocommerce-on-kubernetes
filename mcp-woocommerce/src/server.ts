import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { wc } from "./woo.js";

const TZ = process.env.STORE_TIMEZONE ?? "UTC";

// ---------- helpers ----------

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
});

// "Today" in the STORE's timezone (the container itself usually runs in UTC)
function todayInStoreTz(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date()); // YYYY-MM-DD
}

function nextDay(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Keep only what a model needs: fewer tokens, less noise.
const slimProduct = (p: any) => ({
  id: p.id, name: p.name, price: p.price, status: p.status,
  stock_status: p.stock_status, sku: p.sku,
});

const slimOrder = (o: any) => ({
  id: o.id, status: o.status, total: o.total, currency: o.currency,
  date_created: o.date_created, payment_method: o.payment_method_title,
  customer: `${o.billing?.first_name ?? ""} ${o.billing?.last_name ?? ""}`.trim(),
  items: (o.line_items ?? []).map((i: any) => ({ name: i.name, quantity: i.quantity, total: i.total })),
});

const ORDER_STATUSES = ["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"] as const;

// ---------- tools ----------

function buildServer() {
  const server = new McpServer({ name: "woocommerce-mcp", version: "1.0.0" });

  server.registerTool(
    "list_products",
    {
      title: "List products",
      description: "List products in the store. Optionally search by name.",
      inputSchema: {
        search: z.string().optional().describe("Text to search for in product names"),
        per_page: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ search, per_page }) => {
      try {
        const data = await wc("GET", "/products", { query: { search, per_page } });
        return ok(data.map(slimProduct));
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    "create_product",
    {
      title: "Create product",
      description: "Create a new simple product and publish it on the storefront.",
      inputSchema: {
        name: z.string().min(1).describe("Product name"),
        price: z.string().regex(/^\d+(\.\d{1,2})?$/).describe('Price as a number string, e.g. "149" or "9.99"'),
        description: z.string().optional(),
      },
    },
    async ({ name, price, description }) => {
      try {
        const data = await wc("POST", "/products", {
          body: { name, regular_price: price, description, status: "publish", type: "simple" },
        });
        return ok(slimProduct(data));
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description:
        "List orders for one day (default: today in the store's timezone), optionally filtered by status.",
      inputSchema: {
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
          .describe("Day as YYYY-MM-DD. Defaults to today in the store's timezone."),
        status: z.enum(ORDER_STATUSES).optional(),
        per_page: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ date, status, per_page }) => {
      try {
        const day = date ?? todayInStoreTz();
        const data = await wc("GET", "/orders", {
          query: {
            after: `${day}T00:00:00`,
            before: `${nextDay(day)}T00:00:00`,
            status, per_page, orderby: "date", order: "desc",
          },
        });
        return ok({ date: day, timezone: TZ, count: data.length, orders: data.map(slimOrder) });
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description: "Get full details of one order by its ID.",
      inputSchema: { order_id: z.number().int().positive() },
    },
    async ({ order_id }) => {
      try {
        return ok(slimOrder(await wc("GET", `/orders/${order_id}`)));
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    "update_order_status",
    {
      title: "Update order status",
      description: "Change the status of an order.",
      inputSchema: {
        order_id: z.number().int().positive(),
        status: z.enum(ORDER_STATUSES),
      },
    },
    async ({ order_id, status }) => {
      try {
        return ok(slimOrder(await wc("PUT", `/orders/${order_id}`, { body: { status } })));
      } catch (e) { return fail(e); }
    }
  );

  return server;
}

// ---------- HTTP layer (Streamable HTTP, stateless) ----------

const app = express();
app.use(express.json());

// For Kubernetes readiness/liveness probes later
app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

app.post("/mcp", async (req, res) => {
  // Stateless: a fresh server + transport per request, nothing stored between calls.
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

// Stateless servers don't support server-to-client streams or session deletion
const notAllowed = (_req: express.Request, res: express.Response) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
app.get("/mcp", notAllowed);
app.delete("/mcp", notAllowed);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, "0.0.0.0", () => console.log(`WooCommerce MCP server on :${port}/mcp`));
