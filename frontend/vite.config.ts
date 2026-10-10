import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const rootDir = dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': '/src' },
  },
  build: {
    rollupOptions: {
      input: {
        // Existing landing page entry (must stay) + the self-contained dashboard.
        main: resolve(rootDir, 'index.html'),
        dashboard: resolve(rootDir, 'dashboard.html'),
        // Self-contained animated swarm-graph page (additive, isolated).
        graph: resolve(rootDir, 'graph.html'),
      },
    },
  },
})
