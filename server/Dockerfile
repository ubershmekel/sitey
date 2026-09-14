# Build context is the repo root (see deploy/docker-compose.yml) so the workspace package-lock.json is available.
# Pinned (not node:24-bookworm-slim): floating tags silently pulled Node 24.21, whose native-addon regression (24.19+) broke us.
FROM node:24.18.1-bookworm-slim AS base
WORKDIR /app

# git + CA roots needed for HTTPS clone/pull; openssl/python/build tools for native deps
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git openssl python3 make g++ && rm -rf /var/lib/apt/lists/*

FROM base AS deps
# npm ci validates the lockfile against every workspace manifest, so web/package.json is needed too (web deps aren't installed).
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
# Root "prepare" runs husky (git hooks), which isn't installed here and isn't wanted in an image.
# npm ci installs the exact lockfile versions from their recorded tarball URLs, so --prefer-offline can't hit stale
# registry metadata. The BuildKit cache mount keeps npm's tarball cache across builds (does NOT cache node_modules).
RUN --mount=type=cache,id=sitey-server-npm,target=/root/.npm,sharing=locked \
  npm pkg delete scripts.prepare && \
  npm ci -w server --prefer-offline --no-audit --progress=false
# Dependencies are hoisted to /app/node_modules; Node resolves them from /app/server by walking up.
WORKDIR /app/server

# Development stage — src is mounted as a volume at runtime
FROM deps AS dev
COPY server/prisma ./prisma/
COPY server/prisma.config.ts ./
RUN npm run db:generate
ENV NODE_ENV=development
EXPOSE 3001
# CHOKIDAR_USEPOLLING ensures file watching detects changes on Docker Desktop for Windows/Mac
ENV CHOKIDAR_USEPOLLING=true
CMD ["node", "--watch", "src/index.ts"]

# Production image
FROM deps AS runner
COPY server/prisma ./prisma/
COPY server/prisma.config.ts ./
COPY server/src ./src/
RUN npm run db:generate

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "src/index.ts"]
