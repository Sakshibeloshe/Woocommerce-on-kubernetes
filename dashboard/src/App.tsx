import { useEffect, useState } from 'react'
import { api, type User } from './api'
import { AcceptInvite, Login } from './pages/Login'
import { Servers } from './pages/Servers'
import { Members } from './pages/Members'
import { MyKeys } from './pages/Keys'
import { Audit } from './pages/Audit'
import { Chat } from './pages/Chat'

type Page = 'servers' | 'chat' | 'keys' | 'members' | 'audit'

const NAV: { page: Page; label: string; adminOnly?: boolean }[] = [
  { page: 'servers', label: 'Servers' },
  { page: 'chat', label: 'Chat' },
  { page: 'keys', label: 'My API keys' },
  { page: 'members', label: 'Team', adminOnly: true },
  { page: 'audit', label: 'Audit log' },
]

// Minimal router: the page lives in the URL path (/servers, /chat, ...), so reload and
// back/forward work. nginx serves index.html for every path (see dashboard/nginx.conf).
const pageFromPath = (): Page => {
  const p = window.location.pathname.slice(1) as Page
  return NAV.some((n) => n.page === p) ? p : 'servers'
}

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined)   // undefined = still checking
  const [page, setPage] = useState<Page>(pageFromPath)

  useEffect(() => {
    api.me().then((r) => setUser(r.user)).catch(() => setUser(null))   // 401 = not logged in
    const onPop = () => setPage(pageFromPath())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const go = (p: Page) => { window.history.pushState(null, '', `/${p}`); setPage(p) }

  if (user === undefined) return <div className="auth-page muted">Loading…</div>

  const inviteToken = window.location.pathname === '/invite' ? new URLSearchParams(window.location.search).get('token') : null
  if (inviteToken && !user) return <AcceptInvite token={inviteToken} onLogin={setUser} />
  if (!user) return <Login onLogin={setUser} />

  const visible = NAV.filter((n) => !n.adminOnly || user.role === 'admin')
  const current = visible.some((n) => n.page === page) ? page : 'servers'

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">MCP Gateway</div>
        <nav>
          {visible.map((n) => (
            <a key={n.page} href={`/${n.page}`} className={current === n.page ? 'active' : ''}
              onClick={(e) => { e.preventDefault(); go(n.page) }}>{n.label}</a>
          ))}
        </nav>
        <div className="me">
          <div className="small">{user.email}</div>
          <div className="muted small">{user.role}</div>
          <button className="link" onClick={async () => { await api.logout(); setUser(null) }}>Sign out</button>
        </div>
      </aside>
      <main className="content">
        {current === 'servers' && <Servers user={user} />}
        {current === 'chat' && <Chat />}
        {current === 'keys' && <MyKeys />}
        {current === 'members' && <Members user={user} />}
        {current === 'audit' && <Audit user={user} />}
      </main>
    </div>
  )
}
