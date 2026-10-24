import { useEffect, useRef, useState } from 'react'
import { api, type ChatStep, type ChatTurn } from '../api'
import { ErrorBox, useAction } from '../ui'

type Message = ChatTurn & { steps?: ChatStep[] }

const EXAMPLES = [
  'What orders came in today?',
  'Create a product named Kubernetes Hoodie priced 99',
  "List today's orders and save a note summarizing them",
]

export function Chat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [config, setConfig] = useState<{ enabled: boolean; model: string } | null>(null)
  const { busy, error, run } = useAction()
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => { api.chatConfig().then(setConfig).catch(() => setConfig({ enabled: false, model: '' })) }, [])
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, busy])

  async function send(text: string) {
    if (!text.trim() || busy) return
    const history: Message[] = [...messages, { role: 'user', content: text.trim() }]
    setMessages(history)
    setInput('')
    // The backend is stateless: send the conversation (text only) each time.
    const r = await run(() => api.chat(history.map(({ role, content }) => ({ role, content }))))
    if (r) setMessages([...history, { role: 'assistant', content: r.reply, steps: r.steps }])
  }

  return (
    <div className="chat-page">
      <div className="page-head">
        <div>
          <h2>Chat</h2>
          <p className="muted">
            The assistant uses the same gateway tools as your MCP clients, acting as you: every call it makes appears in the audit log under your name.
            {config?.enabled && <> Model: <code>{config.model}</code>.</>}
          </p>
        </div>
        {messages.length > 0 && <button onClick={() => setMessages([])}>New chat</button>}
      </div>
      {config && !config.enabled && <ErrorBox error="Chat is not configured on the server (no LLM set)." />}

      <div className="chat-log card">
        {messages.length === 0 && (
          <div className="examples">
            <p className="muted">Try:</p>
            {EXAMPLES.map((e) => <button key={e} onClick={() => send(e)} disabled={!config?.enabled}>{e}</button>)}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg msg-${m.role}`}>
            {m.steps && m.steps.length > 0 && (
              <div className="steps">
                {m.steps.map((s, j) => (
                  <details key={j} className={s.ok ? 'step' : 'step step-failed'}>
                    <summary>{s.ok ? '🔧' : '⚠️'} <code>{s.tool}</code> <span className="muted small">{s.duration_ms} ms</span></summary>
                    <div className="small"><b>Arguments</b><pre>{JSON.stringify(s.arguments, null, 2)}</pre></div>
                    <div className="small"><b>Result</b><pre>{s.result}</pre></div>
                  </details>
                ))}
              </div>
            )}
            <div className="bubble">{m.content}</div>
          </div>
        ))}
        {busy && <div className="msg msg-assistant"><div className="bubble muted">Thinking and calling tools…</div></div>}
        <div ref={bottom} />
      </div>
      <ErrorBox error={error} />
      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); send(input) }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about orders, products, notes…" disabled={!config?.enabled} />
        <button className="primary" disabled={busy || !input.trim()}>Send</button>
      </form>
    </div>
  )
}
