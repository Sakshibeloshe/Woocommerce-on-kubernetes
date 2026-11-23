// Small shared building blocks.
import { useState, type ReactNode } from 'react'

export function Badge({ kind, children }: { kind: string; children: ReactNode }) {
  return <span className={`badge badge-${kind}`}>{children}</span>
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? <div className="error-box">{error}</div> : null
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

/** Copy to clipboard. navigator.clipboard only exists on HTTPS/localhost, so fall back to execCommand on plain HTTP. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true }
  } catch { /* fall through */ }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.className = 'offscreen'
  document.body.appendChild(area)
  area.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch { ok = false }
  area.remove()
  return ok
}

/** A value the user must copy now (new API key, invite link). */
export function SecretOnce({ label, value, note }: { label: string; value: string; note: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="secret-once">
      <div className="secret-label">{label}</div>
      <div className="secret-row">
        <code>{value}</code>
        <button onClick={async () => setCopied(await copyText(value))}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="muted small">{note}</p>
    </div>
  )
}

/** Run an async action with a busy flag and an error message. */
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true)
    setError(null)
    try {
      return await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return undefined
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, setError, run }
}

// Stroke icon from one SVG path (no icon library).
export const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
)

export const Brand = () => (
  <div className="brand">
    <div className="brand-mark"><Icon d="M12 3v6M12 15v6M3 12h6M15 12h6M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" /></div>
    <div><div className="brand-name">MCP Gateway</div><div className="brand-sub">one endpoint, every tool</div></div>
  </div>
)
