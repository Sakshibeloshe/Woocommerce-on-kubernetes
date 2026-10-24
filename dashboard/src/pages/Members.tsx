import { useEffect, useState } from 'react'
import { api, timeAgo, type Member, type Role, type User } from '../api'
import { Badge, ErrorBox, Modal, SecretOnce, useAction } from '../ui'
import { KeyManager } from './Keys'

export function Members({ user }: { user: User }) {
  const [members, setMembers] = useState<Member[] | null>(null)
  const [inviting, setInviting] = useState(false)
  const [keysFor, setKeysFor] = useState<Member | null>(null)
  const { error, run } = useAction()

  const load = async () => { const r = await run(api.members); if (r) setMembers(r.users) }
  useEffect(() => { load() }, [])
  const act = async (fn: () => Promise<unknown>) => { await run(fn); load() }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>Team</h2>
          <p className="muted">Admins manage servers and members. Members use the tools (chat and MCP clients).</p>
        </div>
        <button className="primary" onClick={() => setInviting(true)}>Invite member</button>
      </div>
      <ErrorBox error={error} />
      <div className="card">
        <table className="table">
          <thead><tr><th>Member</th><th>Role</th><th>Status</th><th>Active keys</th><th>Joined</th><th /></tr></thead>
          <tbody>
            {members?.map((m) => (
              <tr key={m.id}>
                <td><div>{m.name || m.email}</div><div className="muted small">{m.email}</div></td>
                <td>
                  <select value={m.role} disabled={m.id === user.id}
                    onChange={(e) => act(() => api.updateMember(m.id, { role: e.target.value as Role }))}>
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                  </select>
                </td>
                <td>
                  {m.disabled ? <Badge kind="disabled">Disabled</Badge>
                    : m.invite_pending ? <Badge kind="pending">Invite pending</Badge>
                    : <Badge kind="connected">Active</Badge>}
                </td>
                <td>{m.active_keys}</td>
                <td>{timeAgo(m.created_at)}</td>
                <td className="right actions">
                  <button onClick={() => setKeysFor(m)}>API keys</button>
                  {m.id !== user.id && <>
                    <button onClick={() => act(() => api.updateMember(m.id, { disabled: !m.disabled }))}>{m.disabled ? 'Enable' : 'Disable'}</button>
                    <button className="danger" onClick={() => confirm(`Remove ${m.email}? Their keys stop working.`) && act(() => api.removeMember(m.id))}>Remove</button>
                  </>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {inviting && <InviteForm onClose={() => { setInviting(false); load() }} />}
      {keysFor && (
        <Modal title={`API keys of ${keysFor.email}`} onClose={() => { setKeysFor(null); load() }}>
          <KeyManager load={() => api.memberKeys(keysFor.id)} create={(name) => api.issueMemberKey(keysFor.id, name)} />
        </Modal>
      )}
    </div>
  )
}

function InviteForm({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('member')
  const [link, setLink] = useState<string | null>(null)
  const { busy, error, run } = useAction()

  return (
    <Modal title="Invite a team member" onClose={onClose}>
      {link ? (
        <>
          <SecretOnce label={`Invite link for ${email}`} value={link}
            note="Send this link to them. It works once and expires in 7 days." />
          <div className="form-actions"><button className="primary" onClick={onClose}>Done</button></div>
        </>
      ) : (
        <form className="form" onSubmit={async (e) => {
          e.preventDefault()
          const r = await run(() => api.invite(email, name, role))
          if (r) setLink(r.invite_url)
        }}>
          <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></label>
          <label>Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label>Role
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="member">member: uses tools</option>
              <option value="admin">admin: also manages servers and members</option>
            </select>
          </label>
          <ErrorBox error={error} />
          <div className="form-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button className="primary" disabled={busy}>Create invite</button>
          </div>
        </form>
      )}
    </Modal>
  )
}
