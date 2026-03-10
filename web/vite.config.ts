import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 3000,
    host: true,
    // When running behind a reverse proxy (Caddy in Docker dev), tell the browser
    // to connect the HMR WebSocket to the proxy's port instead of Vite's port 3000.
    hmr: process.env.VITE_HMR_CLIENT_PORT
      ? { clientPort: Number(process.env.VITE_HMR_CLIENT_PORT) }
      : {},
    proxy: {
      '/trpc': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
      '/webhook': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
