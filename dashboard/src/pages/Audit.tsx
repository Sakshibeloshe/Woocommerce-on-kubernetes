import { useEffect, useState } from 'react'
import { api, type AuditEntry, type Member, type User } from '../api'
import { Badge, ErrorBox, useAction } from '../ui'

const OUTCOMES = ['success', 'error', 'timeout', 'unreachable', 'rejected']
const OUTCOME_KIND: Record<string, string> = {
  success: 'connected', error: 'unreachable', timeout: 'pending', unreachable: 'unreachable', rejected: 'disabled',
}

export function Audit({ user }: { user: User }) {
  const isAdmin = user.role === 'admin'
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [filters, setFilters] = useState({ user_id: '', server: '', outcome: '' })
  const [more, setMore] = useState(false)
  const { error, run } = useAction()
  const PAGE = 50

  const query = (extra: Record<string, string> = {}) => {
    const q: Record<string, string> = { limit: String(PAGE), ...extra }
    for (const [k, v] of Object.entries(filters)) if (v) q[k] = v
    return q
  }

  const load = async () => {
    const r = await run(() => api.audit(query()))
    if (r) { setEntries(r.entries); setMore(r.entries.length === PAGE) }
  }
  const loadMore = async () => {
    const r = await run(() => api.audit(query({ before_id: String(entries[entries.length - 1].id) })))
    if (r) { setEntries([...entries, ...r.entries]); setMore(r.entries.length === PAGE) }
  }

  useEffect(() => { load() }, [filters])
  useEffect(() => { if (isAdmin) api.members().then((r) => setMembers(r.users)).catch(() => {}) }, [isAdmin])

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>Audit log</h2>
          <p className="muted">{isAdmin ? 'Every tool call by anyone' : 'Your tool calls'}, through MCP clients, dashboard features, and chat, including rejected and failed ones.</p>
        </div>
        <button onClick={load}>Refresh</button>
      </div>
      <div className="filters">
        {isAdmin && (
          <select value={filters.user_id} onChange={(e) => setFilters({ ...filters, user_id: e.target.value })}>
            <option value="">All users</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}
          </select>
        )}
        <input placeholder="Server slug" value={filters.server} onChange={(e) => setFilters({ ...filters, server: e.target.value.trim() })} />
        <select value={filters.outcome} onChange={(e) => setFilters({ ...filters, outcome: e.target.value })}>
          <option value="">All outcomes</option>
          {OUTCOMES.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
      <ErrorBox error={error} />
      <div className="card">
        <table className="table">
          <thead><tr><th>When</th><th>Who</th><th>Via</th><th>Server</th><th>Tool</th><th className="right">Duration</th><th>Outcome</th></tr></thead>
          <tbody>
            {entries.length === 0 && <tr><td colSpan={7} className="muted">No entries.</td></tr>}
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="nowrap">{new Date(e.ts).toLocaleString()}</td>
                <td>{e.user_email ?? <span className="muted">unknown key</span>}</td>
                <td>{e.source === 'dashboard' ? 'dashboard' : e.source === 'chat' ? 'chat' : 'MCP client'}</td>
                <td><code>{e.server_slug ?? '—'}</code></td>
                <td><code>{e.tool ?? '—'}</code></td>
                <td className="right">{e.duration_ms} ms</td>
                <td>
                  <Badge kind={OUTCOME_KIND[e.outcome]}>{e.outcome}</Badge>
                  {e.error && <div className="muted small wrap">{e.error}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {more && <button className="link" onClick={loadMore}>Load older entries</button>}
      </div>
    </div>
  )
}
