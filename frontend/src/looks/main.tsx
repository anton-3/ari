// Test looks for the fleet map: same function as src/graph, different look.
// Each look lives in src/looks/<name>/Look.tsx (default export + `meta`) and is
// discovered automatically. Open looks.html?look=<name>; no param shows the index.
import { StrictMode, Suspense, lazy, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'

interface LookMeta {
  title: string
  inspiration: string
}
type LookModule = { default: ComponentType; meta?: LookMeta }

const modules = import.meta.glob<LookModule>('./*/Look.tsx')
const names = Object.keys(modules)
  .map((p) => p.split('/')[1])
  .sort()

function Index() {
  return (
    <main style={{ fontFamily: 'JetBrains Mono, monospace', color: '#cfd3cf', background: '#060607', minHeight: '100vh', padding: 32 }}>
      <h1 style={{ fontSize: 14, letterSpacing: '0.2em', textTransform: 'uppercase', fontWeight: 500 }}>map looks</h1>
      <ul style={{ listStyle: 'none', padding: 0, lineHeight: 2 }}>
        <li><a style={{ color: '#59c9a5' }} href="/graph.html">current (graph.html)</a></li>
        {names.map((n) => (
          <li key={n}><a style={{ color: '#59c9a5' }} href={`?look=${n}`}>{n}</a></li>
        ))}
      </ul>
    </main>
  )
}

const name = new URLSearchParams(location.search).get('look')
const loader = name ? modules[`./${name}/Look.tsx`] : undefined
const Look = loader ? lazy(loader) : Index

const el = document.getElementById('looks-root')
if (!el) throw new Error('looks-root element not found')

createRoot(el).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Look />
    </Suspense>
  </StrictMode>,
)
