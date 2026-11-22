import { useEffect, useState } from 'react'
import { api, type User } from './api'
import { AcceptInvite, Login } from './pages/Login'
import { Servers } from './pages/Servers'
import { Members } from './pages/Members'
import { MyKeys } from './pages/Keys'
import { Audit } from './pages/Audit'
import { Chat } from './pages/Chat'
import { Geo } from './pages/Geo'
import { Stores } from './pages/Stores'
import { Brand, Icon } from './ui'

type Page = 'servers' | 'chat' | 'keys' | 'members' | 'audit' | 'geo' | 'stores'

const NAV: { page: Page; label: string; icon: string; adminOnly?: boolean }[] = [
  { page: 'servers', label: 'Servers', icon: 'M4 5h16v5H4zM4 14h16v5H4zM8 7.5h.01M8 16.5h.01' },
  { page: 'stores', label: 'Stores', icon: 'M4 9l1.5-5h13L20 9M4 9h16v11H4zM9 20v-6h6v6' },
  { page: 'geo', label: 'GEO readiness', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12l3 3 5-6' },
  { page: 'chat', label: 'Chat', icon: 'M4 5h16v11H9l-5 4z' },
  { page: 'keys', label: 'My API keys', icon: 'M14 10a4 4 0 1 0-1.2 2.8L20 20M16 16l2-2' },
  { page: 'members', label: 'Team', icon: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c0-3 3-5 6-5s6 2 6 5M16 5a3 3 0 0 1 0 6M18 15c2 .5 3 2 3 5', adminOnly: true },
  { page: 'audit', label: 'Audit log', icon: 'M6 3h9l4 4v14H6zM9 11h7M9 15h7M9 7h3' },
]

const today = () => new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

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
  const display = user.name?.trim() || user.email.split('@')[0]
  const firstName = display.split(/\s+/)[0]
  const initials = display.split(/\s+/).slice(0, 2).map((w) => w[0]).join('')

  return (
    <div className="layout">
      <aside className="sidebar">
        <Brand />
        <nav>
          {visible.map((n) => (
            <a key={n.page} href={`/${n.page}`} className={current === n.page ? 'active' : ''}
              onClick={(e) => { e.preventDefault(); go(n.page) }}><Icon d={n.icon} />{n.label}</a>
          ))}
        </nav>
        <button className="logout" onClick={async () => { await api.logout(); setUser(null) }}>
          <Icon d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />Log out
        </button>
      </aside>
      <main className="content">
        <header className="topbar">
          <div>
            <div className="hello">Hello, {firstName}.</div>
            <div className="hello-sub">{today()}</div>
          </div>
          <div className="who">
            <div className="who-text"><div className="who-name">{user.name || user.email}</div><div className="who-role">{user.role} · {user.email}</div></div>
            <div className="avatar">{initials}</div>
          </div>
        </header>
        {current === 'servers' && <Servers user={user} />}
        {current === 'chat' && <Chat />}
        {current === 'geo' && <Geo />}
        {current === 'stores' && <Stores user={user} />}
        {current === 'keys' && <MyKeys />}
        {current === 'members' && <Members user={user} />}
        {current === 'audit' && <Audit user={user} />}
      </main>
    </div>
  )
}
