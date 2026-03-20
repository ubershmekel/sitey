import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const apiTarget = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3001";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 3000,
    host: true,
    allowedHosts: true,
    // When running behind a reverse proxy (Caddy in Docker dev), tell the browser
    // to connect the HMR WebSocket to the proxy's port instead of Vite's port 3000.
    hmr: process.env.VITE_HMR_CLIENT_PORT
      ? { clientPort: Number(process.env.VITE_HMR_CLIENT_PORT) }
      : {},
    proxy: {
      "/trpc": {
        target: apiTarget,
        changeOrigin: true,
      },
      "/webhook": {
        target: apiTarget,
        changeOrigin: true,
      },
      "/health": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
