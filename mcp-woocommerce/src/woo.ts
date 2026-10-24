// The only file that knows how to talk to WooCommerce's REST API.
const BASE = process.env.WC_BASE_URL;
const KEY = process.env.WC_CONSUMER_KEY;
const SECRET = process.env.WC_CONSUMER_SECRET;

if (!BASE || !KEY || !SECRET) {
  throw new Error("WC_BASE_URL, WC_CONSUMER_KEY and WC_CONSUMER_SECRET must be set");
}

const AUTH = "Basic " + Buffer.from(`${KEY}:${SECRET}`).toString("base64");

type Opts = { query?: Record<string, string | number | undefined>; body?: unknown };

export async function wc(method: string, path: string, opts: Opts = {}) {
  const url = new URL(`${BASE}/wp-json/wc/v3${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: AUTH,
      "X-Forwarded-Proto": "https", // makes WooCommerce accept key:secret over plain HTTP
      "Content-Type": "application/json",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(10_000), // never hang forever on a slow store
  });

  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // WordPress sometimes returns an HTML error page
  }

  if (!res.ok) {
    throw new Error(`WooCommerce ${res.status}: ${data?.message ?? text.slice(0, 200)}`);
  }
  return data;
}
