import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Graph from './Graph.tsx'

const el = document.getElementById('graph-root')
if (!el) throw new Error('graph-root element not found')

createRoot(el).render(
  <StrictMode>
    <Graph />
  </StrictMode>,
)
