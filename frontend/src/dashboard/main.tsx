import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Dashboard from './Dashboard.tsx'

const el = document.getElementById('dashboard-root')
if (!el) throw new Error('dashboard-root element not found')

createRoot(el).render(
  <StrictMode>
    <Dashboard />
  </StrictMode>,
)
