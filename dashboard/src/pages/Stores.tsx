import { useEffect, useState, type FormEvent } from 'react'
import { api, type Store, type User } from '../api'
import { Badge, ErrorBox, useAction } from '../ui'

const label = (store: Store) => store.status === 'waiting_for_namespace' ? 'Waiting for namespace'
  : store.status === 'cleanup_pending' ? 'Cleanup pending'
  : store.status.charAt(0).toUpperCase() + store.status.slice(1)
const kind = (status: Store['status']) => status === 'ready' ? 'connected' : status === 'failed' ? 'unreachable' : status === 'deleted' ? 'disabled' : 'pending'
const live = (store: Store) => store.status !== 'deleted'
const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`

export function Stores({ user }: { user: User }) {
  const [stores, setStores] = useState<Store[]>([])
  const [maxPerUser, setMaxPerUser] = useState(3)
  const [slug, setSlug] = useState('')
  const [title, setTitle] = useState('')
  const [copiedStore, setCopiedStore] = useState<string | null>(null)
  const { busy, error, run } = useAction()

  const load = async () => {
    const result = await run(() => api.stores())
    if (result) { setStores(result.stores); setMaxPerUser(result.max_per_user) }
  }

  useEffect(() => { void load() }, [])
  useEffect(() => {
    const timer = window.setInterval(() => { api.stores().then((r) => { setStores(r.stores); setMaxPerUser(r.max_per_user) }).catch(() => {}) }, 7000)
    return () => window.clearInterval(timer)
  }, [])

  async function create(event: FormEvent) {
    event.preventDefault()
    const result = await run(() => api.createStore({ slug: slug.trim(), title: title.trim() }))
    if (result) {
      setSlug('')
      setTitle('')
      await load()
    }
  }

  async function remove(store: Store) {
    if (!window.confirm(`Remove ${store.title} from the gateway? You will need to delete namespace ${store.namespace} with the operator script to remove its data.`)) return
    const result = await run(() => api.deleteStore(store.id))
    if (result) await load()
  }

  async function provision(store: Store) {
    const result = await run(() => api.provisionStore(store.id))
    if (result) await load()
  }

  async function register(store: Store) {
    const result = await run(() => api.registerStore(store.id))
    if (result) await load()
  }

  async function confirmDeleted(store: Store) {
    if (!window.confirm(`Confirm that namespace ${store.namespace} has been deleted?`)) return
    const result = await run(() => api.confirmStoreNamespaceDeleted(store.id))
    if (result) await load()
  }

  async function copyCleanupCommand(store: Store) {
    const command = `& ".\\scripts\\delete-store-namespace.ps1" -Namespace ${psQuote(store.namespace)}`
    const result = await run(async () => { await navigator.clipboard.writeText(command); return true })
    if (result) {
      setCopiedStore(store.id)
      window.setTimeout(() => setCopiedStore(null), 1800)
    }
  }

  const current = stores.filter((store) => live(store) && store.owner_email === user.email).length
  return (
    <div>
      <div className="page-head">
        <div>
          <h2>Stores</h2>
          <p className="muted">Create isolated WooCommerce stores. A cluster operator prepares each namespace and runs its Helm install from a trusted workstation; the gateway has no Kubernetes credentials.</p>
        </div>
        <button onClick={() => void load()} disabled={busy}>Refresh</button>
      </div>
      <div className="store-capacity card"><b>{current} active or provisioning</b><span className="muted"> · limit {maxPerUser} per user. Provisioning may take a few minutes.</span></div>
      <form className="store-create card" onSubmit={create}>
        <h3>Create a store</h3>
        <label>Store name<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="Blue Shop" required /></label>
        <label>Store slug<input value={slug} onChange={(e) => setSlug(e.target.value)} pattern="[a-z][a-z0-9]*(-[a-z0-9]+)*" maxLength={16} placeholder="blue-shop" required /><span className="muted small">Lowercase letters, numbers, and single hyphens. Slugs are permanent and globally unique.</span></label>
        <div className="form-actions"><button className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create store'}</button></div>
      </form>
      <ErrorBox error={error} />
      {stores.length === 0 && <p className="muted">No stores yet. Create one above to start provisioning.</p>}
      {stores.map((store) => (
        <article className="card store-card" key={store.id}>
          <div className="store-card-head">
            <div>
              <h3>{store.title} <code className="slug">{store.slug}</code></h3>
              {store.status === 'ready' ? <a href={`${window.location.protocol}//${store.hostname}`} target="_blank" rel="noreferrer">{store.hostname}</a> : <span className="muted">{store.hostname}</span>}
              <div className="muted small">Created {new Date(store.created_at).toLocaleString()}{user.role === 'admin' && <> · Owner: {store.owner_email}</>}</div>
            </div>
            <Badge kind={kind(store.status)}>{label(store)}</Badge>
          </div>
          {store.status === 'failed' && store.last_error && <div className="error-text small">Why: {store.last_error}</div>}
          {store.status === 'waiting_for_namespace' && <div className="store-operator card"><b>Operator step</b><p>Open PowerShell in the repository folder and prepare this isolated namespace:</p><pre><code>{`& ".\\scripts\\prepare-store-namespace.ps1" -Namespace ${psQuote(store.namespace)}`}</code></pre><p>After it succeeds, click <b>Start Helm install</b>, then run:</p><pre><code>{`& ".\\scripts\\provision-store.ps1" -Namespace ${psQuote(store.namespace)} -Hostname ${psQuote(store.hostname)} -Title ${psQuote(store.title)}`}</code></pre><p className="muted small">For production, add <code>-ValuesFile "charts/platform/values-prod.yaml"</code>.</p></div>}
          {store.status === 'provisioning' && <div className="store-operator card"><b>Helm install</b><p>Run this command in PowerShell from the repository folder using the cluster operator's kubeconfig. When Helm reports success, click <b>Register MCP</b>.</p><pre><code>{`& ".\\scripts\\provision-store.ps1" -Namespace ${psQuote(store.namespace)} -Hostname ${psQuote(store.hostname)} -Title ${psQuote(store.title)}`}</code></pre><p className="muted small">For production, add <code>-ValuesFile "charts/platform/values-prod.yaml"</code>.</p></div>}
          {store.status === 'cleanup_pending' && <div className="store-operator card"><b>Operator cleanup required</b><p>Gateway tools are removed. Delete the namespace and its workloads, Secrets, database, and PVCs:</p><pre><code>{`& ".\\scripts\\delete-store-namespace.ps1" -Namespace ${psQuote(store.namespace)}`}</code></pre></div>}
          {store.status === 'deleted' && <div className="store-operator card"><b>Dashboard record deleted</b><p>This status does not check Kubernetes. To see whether the namespace still exists, run:</p><pre><code>{`kubectl get namespace ${store.namespace}`}</code></pre><p>If it exists, remove it and its namespaced resources:</p><pre><code>{`& ".\\scripts\\delete-store-namespace.ps1" -Namespace ${psQuote(store.namespace)}`}</code></pre><button onClick={() => void copyCleanupCommand(store)} disabled={busy}>{copiedStore === store.id ? 'Copied cleanup command' : 'Copy cleanup command'}</button><p className="muted small">The PVCs are removed with the namespace; the storage class reclaim policy determines whether the backing volumes are deleted or retained.</p></div>}
          <div className="actions store-actions">
            {user.role === 'admin' && ['waiting_for_namespace', 'failed'].includes(store.status) && <button onClick={() => void provision(store)} disabled={busy}>Start Helm install</button>}
            {user.role === 'admin' && ['provisioning', 'failed'].includes(store.status) && <button onClick={() => void register(store)} disabled={busy}>Register / retry MCP</button>}
            {user.role === 'admin' && store.status === 'cleanup_pending' && <button onClick={() => void confirmDeleted(store)} disabled={busy}>Confirm namespace deleted</button>}
            {store.status !== 'deleted' && <button className="danger" onClick={() => void remove(store)} disabled={busy}>Remove store</button>}
          </div>
          {store.status === 'ready' && <p className="muted small">Gateway tools use the prefix <code>store-{store.slug}__</code>. They appear after the gateway's next upstream refresh.</p>}
        </article>
      ))}
    </div>
  )
}
