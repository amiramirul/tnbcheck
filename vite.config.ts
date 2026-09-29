import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import process from 'node:process'

// https://vite.dev/config/
// Served under a reverse-proxy subpath (e.g. /tnbcheck/) via VITE_BASE_PATH.
// Without this, built asset URLs resolve against the domain root and 404.
const base = process.env.VITE_BASE_PATH || '/'
const allowedHosts = (process.env.VITE_ALLOWED_HOSTS || '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean)

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    proxy: {
      '/api/n8n': {
        target: process.env.N8N_PROXY_TARGET ?? 'http://localhost:5678',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/n8n/, ''),
      },
      '/api/meter': {
        target: process.env.METER_API_PROXY_TARGET ?? 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/meter/, ''),
      },
    },
  },
})
