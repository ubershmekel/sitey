# Pinned (not node:24-bookworm-slim): floating tags silently pulled Node 24.21, whose native-addon regression (24.19+) broke us.
FROM node:24.18.1-bookworm-slim AS builder
WORKDIR /app
COPY web/package*.json ./
RUN npm install
COPY web/ .
# Server source is needed only for the type import in trpc.ts (import type { AppRouter }).
# esbuild erases it at build time; we don't need server node_modules.
COPY server/src /server/src
RUN npx vite build

# Tiny final image — just copies the pre-built dist into the /output volume on startup.
# Pinned so rebuilds are reproducible; bump deliberately.
FROM busybox:1.38.0
COPY --from=builder /app/dist /dist
CMD ["sh", "-c", "cp -r /dist/. /output/ && echo '[sitey-web] build deployed to /output'"]
