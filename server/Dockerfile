FROM node:24-bookworm-slim AS base
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
RUN npm run db:generate
ENV NODE_ENV=development
EXPOSE 3001
# CHOKIDAR_USEPOLLING ensures file watching detects changes on Docker Desktop for Windows/Mac
ENV CHOKIDAR_USEPOLLING=true
CMD ["node", "--watch", "src/index.ts"]

# Production image
FROM deps AS runner
COPY prisma ./prisma/
COPY prisma.config.ts ./
COPY src ./src/
RUN npm run db:generate

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "src/index.ts"]
