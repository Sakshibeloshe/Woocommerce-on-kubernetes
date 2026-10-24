import { useCallback, useEffect, useState } from 'react'
import { api, timeAgo, type Credential, type Server, type User } from '../api'
import { Badge, ErrorBox, Modal, useAction } from '../ui'

const STATUS_LABEL = { connected: 'Connected', unreachable: 'Unreachable', disabled: 'Disabled' }

export function Servers({ user }: { user: User }) {
  const isAdmin = user.role === 'admin'
  const [servers, setServers] = useState<Server[] | null>(null)
  const [editing, setEditing] = useState<Server | 'new' | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const { error, run } = useAction()

  const load = useCallback(async () => {
    const r = await run(() => api.servers())
    if (r) setServers(r.servers)
  }, [])

  // Status changes in the background (health checks), so refresh every 5 seconds.
  useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [load])

  const act = async (fn: () => Promise<unknown>) => { await run(fn); await load() }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>MCP servers</h2>
          <p className="muted">Every enabled server's tools are available through one gateway endpoint, as <code>slug__tool</code>.</p>
        </div>
        {isAdmin && <button className="primary" onClick={() => setEditing('new')}>Add server</button>}
      </div>
      <ErrorBox error={error} />
      {!servers && <p className="muted">Loading…</p>}

      <div className="server-list">
        {servers?.map((s) => (
          <div className="card" key={s.id}>
            <div className="server-head">
              <div>
                <div className="server-title">
                  {s.name} <code className="slug">{s.slug}</code>
                  <Badge kind={s.status}>{STATUS_LABEL[s.status]}</Badge>
                </div>
                <div className="muted small">
                  {isAdmin && <>{s.url} · </>}
                  {isAdmin && s.credential && <>credential: {s.credential.type === 'none' ? 'none' : `${s.credential.type}${s.credential.header_name ? ` (${s.credential.header_name})` : ''}, set`} · </>}
                  checked {timeAgo(s.last_checked_at)}
                </div>
                {s.status === 'unreachable' && s.last_error && <div className="error-text small">Why: {s.last_error}</div>}
              </div>
              {isAdmin && (
                <div className="actions">
                  <button onClick={() => act(() => api.refreshServer(s.id))}>Check now</button>
                  <button onClick={() => act(() => api.updateServer(s.id, { enabled: !s.enabled }))}>{s.enabled ? 'Disable' : 'Enable'}</button>
                  <button onClick={() => setEditing(s)}>Edit</button>
                  <button className="danger" onClick={() => confirm(`Remove ${s.name}? Its tools disappear for everyone.`) && act(() => api.removeServer(s.id))}>Remove</button>
                </div>
              )}
            </div>
            {s.tools.length > 0 && (
              <div>
                <button className="link" onClick={() => setOpen({ ...open, [s.id]: !open[s.id] })}>
                  {open[s.id] ? '▾' : '▸'} {s.tools.length} tools
                </button>
                {open[s.id] ? (
                  <table className="tools-table"><tbody>
                    {s.tools.map((t) => <tr key={t.name}><td><code>{t.name}</code></td><td className="muted">{t.description}</td></tr>)}
                  </tbody></table>
                ) : (
                  <div className="chips">{s.tools.map((t) => <code key={t.name} className="chip">{t.original_name}</code>)}</div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {editing && (
        <ServerForm
          server={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}
    </div>
  )
}

function ServerForm({ server, onClose, onSaved }: { server: Server | null; onClose: () => void; onSaved: () => void }) {
  const isNew = !server
  const [slug, setSlug] = useState('')
  const [name, setName] = useState(server?.name ?? '')
  const [url, setUrl] = useState(server?.url ?? '')
  // For edits, "keep" leaves the stored credential untouched (we can't show it: it's write-only).
  const [credMode, setCredMode] = useState<'keep' | 'none' | 'bearer' | 'header'>(isNew ? 'none' : 'keep')
  const [headerName, setHeaderName] = useState('')
  const [secret, setSecret] = useState('')
  const { busy, error, run } = useAction()

  function credential(): Credential | undefined {
    if (credMode === 'keep') return undefined
    if (credMode === 'none') return { type: 'none' }
    if (credMode === 'bearer') return { type: 'bearer', value: secret }
    return { type: 'header', header_name: headerName, value: secret }
  }

  return (
    <Modal title={isNew ? 'Add MCP server' : `Edit ${server.name}`} onClose={onClose}>
      <form className="form" onSubmit={async (e) => {
        e.preventDefault()
        const ok = await run(() => isNew
          ? api.addServer({ slug, name, url, credential: credential()! })
          : api.updateServer(server.id, { name, url, credential: credential() }))
        if (ok) onSaved()
      }}>
        {isNew && (
          <label>Slug <span className="muted small">(tool prefix, can't be changed later)</span>
            <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="e.g. crm" pattern="[a-z][a-z0-9]*(-[a-z0-9]+)*" maxLength={24} required />
          </label>
        )}
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label>URL (Streamable HTTP endpoint)<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://my-server.namespace.svc/mcp" required /></label>
        <label>Credential
          <select value={credMode} onChange={(e) => setCredMode(e.target.value as typeof credMode)}>
            {!isNew && <option value="keep">Keep current ({server.credential?.type === 'none' ? 'none' : 'set'})</option>}
            <option value="none">None</option>
            <option value="bearer">Bearer token</option>
            <option value="header">Custom header</option>
          </select>
        </label>
        {credMode === 'header' && (
          <label>Header name<input value={headerName} onChange={(e) => setHeaderName(e.target.value)} placeholder="X-API-Key" required /></label>
        )}
        {(credMode === 'bearer' || credMode === 'header') && (
          <label>Secret value
            <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" required />
            <span className="muted small">Stored encrypted on the server. It is never shown again, to anyone.</span>
          </label>
        )}
        <ErrorBox error={error} />
        <div className="form-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy}>{busy ? 'Connecting…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  )
}
