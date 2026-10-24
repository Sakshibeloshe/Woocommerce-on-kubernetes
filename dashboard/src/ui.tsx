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

/** A value the user must copy now (new API key, invite link). */
export function SecretOnce({ label, value, note }: { label: string; value: string; note: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="secret-once">
      <div className="secret-label">{label}</div>
      <div className="secret-row">
        <code>{value}</code>
        <button onClick={async () => { await navigator.clipboard.writeText(value); setCopied(true) }}>
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
