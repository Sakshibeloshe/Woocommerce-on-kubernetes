// Toolbox MCP server: small utilities a model is bad at doing in its head.
// No credential required (unlike mcp-notes), so the gateway shows both cases.
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ---------- helpers ----------

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

const fail = (message: string) => ({
  isError: true,
  content: [{ type: "text" as const, text: message }],
});

// Static demo rates: units of each currency per 1 USD. Deliberately offline, so the
// demo never depends on an external API. Not for real money.
const RATES_AS_OF = "2026-10-01";
const PER_USD: Record<string, number> = {
  USD: 1, INR: 88.2, EUR: 0.86, GBP: 0.75, JPY: 149.5, AED: 3.67, SGD: 1.29, AUD: 1.52, CAD: 1.39,
};

// A tiny arithmetic parser (+ - * / %, parentheses, unary minus).
// Never use eval() for model-provided input: it would run arbitrary JavaScript.
function calculate(expr: string): number {
  const tokens = expr.match(/\d+(\.\d+)?|[-+*/%()]/g) ?? [];
  if (tokens.join("") !== expr.replace(/\s+/g, "")) throw new Error("Only numbers, + - * / % and parentheses are allowed");
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];

  function expression(): number {            // term (('+'|'-') term)*
    let v = term();
    while (peek() === "+" || peek() === "-") v = next() === "+" ? v + term() : v - term();
    return v;
  }
  function term(): number {                  // factor (('*'|'/'|'%') factor)*
    let v = factor();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = next(), r = factor();
      if (op !== "*" && r === 0) throw new Error("Division by zero");
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  }
  function factor(): number {                // number | '(' expression ')' | '-' factor
    const t = next();
    if (t === "-") return -factor();
    if (t === "(") {
      const v = expression();
      if (next() !== ")") throw new Error("Missing closing parenthesis");
      return v;
    }
    if (t !== undefined && /^\d/.test(t)) return Number(t);
    throw new Error(`Unexpected ${t ?? "end of expression"}`);
  }

  const result = expression();
  if (i < tokens.length) throw new Error(`Unexpected ${peek()}`);
  return result;
}

// ---------- tools ----------

function buildServer() {
  const server = new McpServer({ name: "toolbox-mcp", version: "1.0.0" });
  const currency = z.string().length(3).transform((s) => s.toUpperCase());

  server.registerTool(
    "convert_currency",
    {
      title: "Convert currency",
      description: `Convert an amount between currencies using fixed demo rates (as of ${RATES_AS_OF}). Supported: ${Object.keys(PER_USD).join(", ")}.`,
      inputSchema: { amount: z.number(), from: currency, to: currency },
    },
    async ({ amount, from, to }) => {
      if (!PER_USD[from] || !PER_USD[to]) return fail(`Unsupported currency. Supported: ${Object.keys(PER_USD).join(", ")}`);
      const rate = PER_USD[to] / PER_USD[from];
      return ok({ amount, from, to, rate: +rate.toFixed(6), result: +(amount * rate).toFixed(2), rates_as_of: RATES_AS_OF });
    }
  );

  server.registerTool(
    "get_current_time",
    {
      title: "Get current time",
      description: "Current date and time in an IANA timezone, e.g. Asia/Kolkata or Europe/London.",
      inputSchema: { timezone: z.string().default("UTC") },
    },
    async ({ timezone }) => {
      try {
        const now = new Date();
        const local = new Intl.DateTimeFormat("en-CA", {
          timeZone: timezone, dateStyle: "short", timeStyle: "medium", hourCycle: "h23",
        }).format(now);
        return ok({ timezone, local, utc: now.toISOString() });
      } catch {
        return fail(`Unknown timezone: ${timezone}`);
      }
    }
  );

  server.registerTool(
    "calculate",
    {
      title: "Calculate",
      description: "Evaluate an arithmetic expression, e.g. \"(499 + 25) * 2\". Supports + - * / % and parentheses.",
      inputSchema: { expression: z.string().min(1).max(500) },
    },
    async ({ expression }) => {
      try {
        return ok({ expression, result: calculate(expression) });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    }
  );

  return server;
}

// ---------- HTTP layer ----------

const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

app.post("/mcp", async (req, res) => {
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
app.listen(port, "0.0.0.0", () => console.log(`Toolbox MCP server on :${port}/mcp`));
