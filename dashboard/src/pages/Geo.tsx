import { useEffect, useState } from 'react'
import { api, type GeoReport } from '../api'
import { Badge, ErrorBox, useAction } from '../ui'

const scoreKind = (score: number) => score >= 80 ? 'connected' : score >= 50 ? 'pending' : 'unreachable'

export function Geo() {
  const [report, setReport] = useState<GeoReport | null>(null)
  const [search, setSearch] = useState('')
  const { busy, error, run } = useAction()

  const load = async (term = search) => {
    const result = await run(() => api.geo(term))
    if (result) setReport(result)
  }

  useEffect(() => { void load('') }, [])

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>GEO readiness</h2>
          <p className="muted">Check whether product listings provide clear, structured facts that AI shopping assistants can use to understand and match products.</p>
        </div>
        <button onClick={() => void load()} disabled={busy}>{busy ? 'Assessing…' : 'Refresh assessment'}</button>
      </div>
      <div className="geo-note card">
        <b>What this score means</b>
        <p className="muted">A deterministic completeness checklist for listing quality. It is not an AI ranking score and does not guarantee that a product will be recommended.</p>
      </div>
      <form className="inline-form" onSubmit={(event) => { event.preventDefault(); void load() }}>
        <input aria-label="Search products" placeholder="Filter by product name" value={search} onChange={(event) => setSearch(event.target.value)} />
        <button type="submit" disabled={busy}>Search</button>
      </form>
      <ErrorBox error={error} />
      {report && <>
        <div className="geo-summary card">
          <div><strong>{report.assessed}</strong><span className="muted"> published products assessed</span></div>
          <div><strong>{report.average_score}%</strong><span className="muted"> average GEO readiness</span></div>
          <span className="muted small">Scores use the same weighted checks for every product.</span>
        </div>
        {report.products.length === 0 && <p className="muted">No published products matched this search.</p>}
        {report.products.map((product) => (
          <article className="card geo-product" key={product.id}>
            <div className="geo-product-head">
              <div><h3>{product.name}</h3><span className="muted small">Product #{product.id}</span>{product.permalink && <> · <a href={product.permalink} target="_blank" rel="noreferrer">View product</a></>}</div>
              <Badge kind={scoreKind(product.score)}>{product.score}%</Badge>
            </div>
            <div className="geo-checks">
              {product.checks.map((check) => (
                <div className="geo-check" key={check.key}>
                  <span className={check.passed ? 'geo-pass' : 'geo-miss'} aria-label={check.passed ? 'Passed' : 'Needs attention'}>{check.passed ? '✓' : '○'}</span>
                  <div><b>{check.label}</b><div className="muted small">{check.detail}</div>{!check.passed && check.recommendation && <div className="geo-recommendation">Suggested fix: {check.recommendation}</div>}</div>
                  <span className="muted small">{check.weight} pts</span>
                </div>
              ))}
            </div>
            <details className="geo-record">
              <summary>Preview agent-readable product facts</summary>
              <p className="muted small">Generated from fields already present in WooCommerce. Missing facts stay empty.</p>
              <pre>{JSON.stringify(product.structured_record, null, 2)}</pre>
            </details>
          </article>
        ))}
      </>}
    </div>
  )
}
