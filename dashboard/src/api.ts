// Tiny client for the gateway's REST API. The browser sends the session cookie
// automatically (same origin), so no token is ever handled in JavaScript.

export type Role = 'admin' | 'member'
export type User = { id: string; email: string; name: string; role: Role }

export type ServerTool = { name: string; original_name: string; description: string }
export type Server = {
  id: string; slug: string; name: string; enabled: boolean
  status: 'connected' | 'unreachable' | 'disabled'
  last_error: string | null; last_checked_at: string | null
  tools: ServerTool[]
  url?: string                                      // admins only
  credential?: { type: 'none' | 'bearer' | 'header'; header_name: string | null; configured: boolean }
}
export type Credential =
  | { type: 'none' }
  | { type: 'bearer'; value: string }
  | { type: 'header'; header_name: string; value: string }

export type Member = {
  id: string; email: string; name: string; role: Role; disabled: boolean
  invite_pending: boolean; active_keys: number; created_at: string
}
export type ApiKey = { id: string; name: string; prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null }
export type NewApiKey = ApiKey & { key: string }

export type AuditEntry = {
  id: number; ts: string; user_id: string | null; user_email: string | null; source: 'mcp' | 'chat'
  server_slug: string | null; tool: string | null; duration_ms: number
  outcome: 'success' | 'error' | 'timeout' | 'unreachable' | 'rejected'; error: string | null
}

export type ChatTurn = { role: 'user' | 'assistant'; content: string }
export type ChatStep = { tool: string; arguments: unknown; ok: boolean; result: string; duration_ms: number }

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const details = Array.isArray(data.details) ? `: ${data.details.join('; ')}` : ''
    throw new ApiError((data.error ?? `Request failed (${res.status})`) + details, res.status)
  }
  return data as T
}

export const api = {
  me: () => request<{ user: User }>('GET', '/api/auth/me'),
  login: (email: string, password: string) => request<{ user: User }>('POST', '/api/auth/login', { email, password }),
  logout: () => request('POST', '/api/auth/logout'),
  acceptInvite: (token: string, password: string) => request<{ user: User }>('POST', '/api/auth/accept-invite', { token, password }),

  servers: () => request<{ servers: Server[] }>('GET', '/api/servers'),
  addServer: (s: { slug: string; name: string; url: string; credential: Credential }) =>
    request<{ server: Server }>('POST', '/api/servers', s),
  updateServer: (id: string, s: { name?: string; url?: string; enabled?: boolean; credential?: Credential }) =>
    request<{ server: Server }>('PATCH', `/api/servers/${id}`, s),
  removeServer: (id: string) => request('DELETE', `/api/servers/${id}`),
  refreshServer: (id: string) => request<{ server: Server }>('POST', `/api/servers/${id}/refresh`),

  members: () => request<{ users: Member[] }>('GET', '/api/users'),
  invite: (email: string, name: string, role: Role) =>
    request<{ invite_url: string; expires_in_days: number }>('POST', '/api/users', { email, name, role }),
  updateMember: (id: string, m: { role?: Role; disabled?: boolean }) => request('PATCH', `/api/users/${id}`, m),
  removeMember: (id: string) => request('DELETE', `/api/users/${id}`),
  memberKeys: (id: string) => request<{ keys: ApiKey[] }>('GET', `/api/users/${id}/keys`),
  issueMemberKey: (id: string, name: string) => request<NewApiKey>('POST', `/api/users/${id}/keys`, { name }),

  myKeys: () => request<{ keys: ApiKey[] }>('GET', '/api/keys'),
  createKey: (name: string) => request<NewApiKey>('POST', '/api/keys', { name }),
  revokeKey: (id: string) => request('DELETE', `/api/keys/${id}`),

  audit: (q: Record<string, string>) =>
    request<{ entries: AuditEntry[] }>('GET', `/api/audit?${new URLSearchParams(q)}`),

  chatConfig: () => request<{ enabled: boolean; model: string }>('GET', '/api/chat/config'),
  chat: (messages: ChatTurn[]) => request<{ reply: string; steps: ChatStep[] }>('POST', '/api/chat', { messages }),
}

export const timeAgo = (iso: string | null) => {
  if (!iso) return 'never'
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return new Date(iso).toLocaleDateString()
}
