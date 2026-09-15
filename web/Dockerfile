# Build context is the repo root (see deploy/docker-compose.yml) so the workspace package-lock.json is available.
# Pinned (not node:24-bookworm-slim): floating tags silently pulled Node 24.21, whose native-addon regression (24.19+) broke us.
FROM node:24.18.1-bookworm-slim AS builder
WORKDIR /app
# npm ci validates the lockfile against every workspace manifest, so server/ and siteyctl/package.json are needed too (server deps aren't installed).
COPY package.json package-lock.json ./
COPY web/package.json ./web/
COPY server/package.json ./server/
COPY siteyctl/package.json ./siteyctl/
# Root "prepare" runs husky (git hooks), which isn't installed here and isn't wanted in an image.
RUN npm pkg delete scripts.prepare && npm ci -w web --no-audit --progress=false
COPY web/ ./web/
# Server source is needed only for the type import in trpc.ts (import type { AppRouter }).
# esbuild erases it at build time; we don't need server node_modules.
COPY server/src ./server/src
WORKDIR /app/web
RUN npx vite build

# Tiny final image — just copies the pre-built dist into the /output volume on startup.
# Pinned so rebuilds are reproducible; bump deliberately.
FROM busybox:1.38.0
COPY --from=builder /app/web/dist /dist
CMD ["sh", "-c", "cp -r /dist/. /output/ && echo '[sitey-web] build deployed to /output'"]
