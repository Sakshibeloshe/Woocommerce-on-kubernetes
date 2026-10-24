import { useEffect, useState } from 'react'
import { api, timeAgo, type ApiKey, type NewApiKey } from '../api'
import { Badge, ErrorBox, SecretOnce, useAction } from '../ui'

/** A list of API keys with "create" and "revoke". Used for "My keys" and, by admins, per member. */
export function KeyManager({ load, create }: {
  load: () => Promise<{ keys: ApiKey[] }>
  create: (name: string) => Promise<NewApiKey>
}) {
  const [keys, setKeys] = useState<ApiKey[] | null>(null)
  const [name, setName] = useState('')
  const [fresh, setFresh] = useState<NewApiKey | null>(null)
  const { busy, error, run } = useAction()

  const reload = async () => { const r = await run(load); if (r) setKeys(r.keys) }
  useEffect(() => { reload() }, [])

  return (
    <div>
      <form className="inline-form" onSubmit={async (e) => {
        e.preventDefault()
        const k = await run(() => create(name || 'key'))
        if (k) { setFresh(k); setName(''); reload() }
      }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Key name, e.g. laptop-claude-code" maxLength={100} />
        <button className="primary" disabled={busy}>Generate key</button>
      </form>
      {fresh && (
        <SecretOnce label={`New key "${fresh.name}"`} value={fresh.key}
          note="Copy it now. Only a hash is stored, so it can never be shown again." />
      )}
      <ErrorBox error={error} />
      <table className="table">
        <thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th>Status</th><th /></tr></thead>
        <tbody>
          {keys?.length === 0 && <tr><td colSpan={6} className="muted">No keys yet.</td></tr>}
          {keys?.map((k) => (
            <tr key={k.id} className={k.revoked_at ? 'dim' : ''}>
              <td>{k.name || '—'}</td>
              <td><code>{k.prefix}…</code></td>
              <td>{timeAgo(k.created_at)}</td>
              <td>{timeAgo(k.last_used_at)}</td>
              <td>{k.revoked_at ? <Badge kind="disabled">Revoked</Badge> : <Badge kind="connected">Active</Badge>}</td>
              <td className="right">
                {!k.revoked_at && (
                  <button className="danger" onClick={async () => {
                    if (!confirm(`Revoke "${k.name}"? Clients using it stop working immediately.`)) return
                    await run(() => api.revokeKey(k.id)); reload()
                  }}>Revoke</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function MyKeys() {
  const endpoint = `${window.location.origin}/mcp`
  return (
    <div>
      <div className="page-head">
        <div>
          <h2>My API keys</h2>
          <p className="muted">One key + one URL gives an MCP client every enabled server's tools. You never need the servers' own credentials.</p>
        </div>
      </div>
      <div className="card">
        <KeyManager load={api.myKeys} create={api.createKey} />
      </div>
      <div className="card">
        <h3>Connect a client</h3>
        <p>Gateway URL: <code>{endpoint}</code> (Streamable HTTP), header <code>Authorization: Bearer &lt;your key&gt;</code>.</p>
        <p className="muted small">Claude Code:</p>
        <pre>{`claude mcp add --transport http gateway ${endpoint} --header "Authorization: Bearer <your key>"`}</pre>
        <p className="muted small">Cursor (<code>~/.cursor/mcp.json</code>):</p>
        <pre>{`{ "mcpServers": { "gateway": { "url": "${endpoint}", "headers": { "Authorization": "Bearer <your key>" } } } }`}</pre>
        <p className="muted small">MCP Inspector: <code>npx @modelcontextprotocol/inspector</code> → Streamable HTTP → URL above → add the Authorization header.</p>
      </div>
    </div>
  )
}
