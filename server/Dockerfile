FROM node:22-bookworm-slim AS base
WORKDIR /app

# git + openssl needed at build time (git for simple-git; openssl for argon2/TLS)
RUN apt-get update && apt-get install -y --no-install-recommends git openssl python3 make g++ && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm install

# Development stage — src is mounted as a volume at runtime
FROM deps AS dev
COPY prisma ./prisma/
COPY prisma.config.ts ./
RUN npx prisma generate
ENV NODE_ENV=development
EXPOSE 3001
# CHOKIDAR_USEPOLLING ensures tsx watch detects changes on Docker Desktop for Windows/Mac
ENV CHOKIDAR_USEPOLLING=true
CMD ["npx", "tsx", "watch", "src/index.ts"]

# Build
FROM deps AS builder
COPY prisma ./prisma/
COPY prisma.config.ts ./
COPY src ./src
COPY tsconfig.json ./
RUN npm run build
RUN npx prisma generate

# Production image
FROM node:22-bookworm-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends git openssl && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./
COPY --from=builder /app/package.json ./

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "--enable-source-maps", "dist/index.js"]
