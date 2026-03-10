FROM node:22-bookworm-slim AS base
WORKDIR /app

# git + CA roots needed for HTTPS clone/pull; openssl/python/build tools for native deps
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git openssl python3 make g++ && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package*.json ./
# BuildKit cache mount keeps npm's package tarball cache across builds (does NOT cache node_modules),
# and these flags reduce registry/audit chatter to speed up rebuilds when dependencies are unchanged.
RUN --mount=type=cache,id=sitey-server-npm,target=/root/.npm,sharing=locked \
  npm install --prefer-offline --no-audit --progress=false

# Development stage — src is mounted as a volume at runtime
FROM deps AS dev
COPY prisma ./prisma/
COPY prisma.config.ts ./
COPY scripts ./scripts/
RUN npm run db:generate
ENV NODE_ENV=development
EXPOSE 3001
# CHOKIDAR_USEPOLLING ensures tsx watch detects changes on Docker Desktop for Windows/Mac
ENV CHOKIDAR_USEPOLLING=true
CMD ["npx", "tsx", "watch", "src/index.ts"]

# Build
FROM deps AS builder
COPY prisma ./prisma/
COPY prisma.config.ts ./
COPY scripts ./scripts/
COPY src ./src
COPY tsconfig.json ./
RUN npm run db:generate
RUN npm run build

# Production image
FROM node:22-bookworm-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git openssl && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/package.json ./

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "--enable-source-maps", "dist/index.js"]
