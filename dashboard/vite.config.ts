import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// In development ("npm run dev"), forward API and MCP calls to the gateway running in
// the cluster, so the browser sees one origin, exactly like behind the Ingress.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://dashboard.localtest.me', changeOrigin: true },
      '/mcp': { target: 'http://dashboard.localtest.me', changeOrigin: true },
    },
  },
})
