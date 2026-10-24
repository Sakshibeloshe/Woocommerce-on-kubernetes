// All configuration comes from environment variables (in Kubernetes: ConfigMap + Secrets).
// The Postgres connection uses the standard PGHOST / PGUSER / PGPASSWORD / PGDATABASE
// variables, which the "pg" library reads by itself.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Environment variable ${name} must be set`);
  return v;
}

const encryptionKey = Buffer.from(required("ENCRYPTION_KEY"), "hex");
if (encryptionKey.length !== 32) {
  throw new Error("ENCRYPTION_KEY must be 32 bytes, hex-encoded (64 hex characters)");
}

const sessionSecret = required("SESSION_SECRET");
if (sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");

export const config = {
  port: Number(process.env.PORT ?? 8080),
  // Public base URL of the dashboard, used to build invite links.
  publicUrl: process.env.PUBLIC_URL ?? "http://dashboard.localtest.me",
  sessionSecret: new TextEncoder().encode(sessionSecret),
  encryptionKey,
  cookieSecure: process.env.COOKIE_SECURE === "true", // true behind HTTPS (production)

  // First admin, created only when the users table is empty.
  bootstrapAdmin: {
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  },
  // JSON file listing upstream servers to register on first start.
  seedServersFile: process.env.SEED_SERVERS_FILE,

  timeouts: {
    connectMs: Number(process.env.UPSTREAM_CONNECT_TIMEOUT_MS ?? 5_000),
    listMs: Number(process.env.UPSTREAM_LIST_TIMEOUT_MS ?? 5_000),
    callMs: Number(process.env.UPSTREAM_CALL_TIMEOUT_MS ?? 30_000),
  },
  // How often every upstream is re-checked (status + tool list).
  refreshIntervalMs: Number(process.env.UPSTREAM_REFRESH_INTERVAL_MS ?? 15_000),

  // Chat agent: any OpenAI-compatible chat completions API.
  //   Ollama: http://host.docker.internal:11434/v1   Groq: https://api.groq.com/openai/v1
  //   Gemini: https://generativelanguage.googleapis.com/v1beta/openai
  llm: {
    baseUrl: process.env.LLM_BASE_URL ?? "",
    model: process.env.LLM_MODEL ?? "qwen3:8b",
    apiKey: process.env.LLM_API_KEY ?? "",       // from a Secret; empty for Ollama
    // Optional, e.g. "none" to switch off qwen3's slow "thinking" mode on Ollama.
    reasoningEffort: process.env.LLM_REASONING_EFFORT ?? "",
    maxIterations: Number(process.env.LLM_MAX_ITERATIONS ?? 8),
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 120_000),
  },
};
