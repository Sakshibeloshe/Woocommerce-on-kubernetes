import { useState } from 'react'
import { api, type User } from '../api'
import { ErrorBox, useAction } from '../ui'

export function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const { busy, error, run } = useAction()

  return (
    <div className="auth-page">
      <form className="card auth-card" onSubmit={async (e) => {
        e.preventDefault()
        const r = await run(() => api.login(email, password))
        if (r) onLogin(r.user)
      }}>
        <h1>MCP Gateway</h1>
        <p className="muted">Sign in to manage servers, keys and chat with your tools.</p>
        <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        <ErrorBox error={error} />
        <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  )
}

/** /invite?token=...: an invited member chooses their password. */
export function AcceptInvite({ token, onLogin }: { token: string; onLogin: (u: User) => void }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const { busy, error, setError, run } = useAction()

  return (
    <div className="auth-page">
      <form className="card auth-card" onSubmit={async (e) => {
        e.preventDefault()
        if (password !== confirm) return setError('Passwords do not match')
        const r = await run(() => api.acceptInvite(token, password))
        if (r) {
          window.history.replaceState(null, '', '/')
          onLogin(r.user)
        }
      }}>
        <h1>Join the team</h1>
        <p className="muted">Choose a password (at least 10 characters).</p>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} required autoFocus /></label>
        <label>Repeat password<input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required /></label>
        <ErrorBox error={error} />
        <button className="primary" disabled={busy}>Create account</button>
      </form>
    </div>
  )
}
