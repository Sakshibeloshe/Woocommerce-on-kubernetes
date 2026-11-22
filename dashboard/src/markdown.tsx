// Tiny Markdown renderer for chat replies: **bold**, *italic*, `code`, lists, paragraphs.
// Builds React elements (never innerHTML), so model output can't inject HTML.
import type { ReactNode } from 'react'

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s\n][^*\n]*\*|_[^_\s\n][^_\n]*_)/g

function inline(text: string, key = ''): ReactNode[] {
  return text.split(INLINE).filter(Boolean).map((part, i) => {
    const k = `${key}${i}`
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={k}>{part.slice(1, -1)}</code>
    if ((part.startsWith('**') && part.endsWith('**') || part.startsWith('__') && part.endsWith('__')) && part.length > 4)
      return <strong key={k}>{inline(part.slice(2, -2), k)}</strong>
    if ((part.startsWith('*') && part.endsWith('*') || part.startsWith('_') && part.endsWith('_')) && part.length > 2)
      return <em key={k}>{inline(part.slice(1, -1), k)}</em>
    return part
  })
}

type Block = { kind: 'p' | 'ul' | 'ol' | 'h' | 'pre'; lines: string[] }

export function Markdown({ text }: { text: string }) {
  const blocks: Block[] = []
  const push = (kind: Block['kind'], line: string) => {
    const last = blocks[blocks.length - 1]
    if (last && last.kind === kind && kind !== 'h') last.lines.push(line)
    else blocks.push({ kind, lines: [line] })
  }
  let fence = false
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd()
    if (line.trim().startsWith('```')) { fence = !fence; if (fence) blocks.push({ kind: 'pre', lines: [] }); continue }
    if (fence) { blocks[blocks.length - 1].lines.push(raw); continue }
    const t = line.trim()
    let m: RegExpMatchArray | null
    if (!t) blocks.push({ kind: 'p', lines: [] })                       // blank line ends the block
    else if ((m = t.match(/^[-*•]\s+(.*)$/))) push('ul', m[1])
    else if ((m = t.match(/^\d+[.)]\s+(.*)$/))) push('ol', m[1])
    else if ((m = t.match(/^#{1,6}\s+(.*)$/))) push('h', m[1])
    else if (t.startsWith('|')) push('pre', t)                          // tables: show as monospace
    else push('p', t)
  }
  return (
    <div className="md">
      {blocks.filter((b) => b.lines.length).map((b, i) => {
        if (b.kind === 'ul') return <ul key={i}>{b.lines.map((l, j) => <li key={j}>{inline(l)}</li>)}</ul>
        if (b.kind === 'ol') return <ol key={i}>{b.lines.map((l, j) => <li key={j}>{inline(l)}</li>)}</ol>
        if (b.kind === 'h') return <p key={i} className="md-h">{inline(b.lines[0])}</p>
        if (b.kind === 'pre') return <pre key={i}>{b.lines.join('\n')}</pre>
        return <p key={i}>{b.lines.flatMap((l, j) => (j ? [<br key={`b${j}`} />, ...inline(l, `${j}-`)] : inline(l, `${j}-`)))}</p>
      })}
    </div>
  )
}
