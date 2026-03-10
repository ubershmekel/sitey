FROM node:25-alpine AS base
WORKDIR /app

# Install build tools for native modules (argon2)
RUN apk add --no-cache python3 make g++ git openssl

# Dependencies — skip prisma's postinstall generate; we run it explicitly below.
FROM base AS deps
COPY package*.json ./
RUN PRISMA_GENERATE_SKIP_AUTOINSTALL=true npm install

# Development stage — src is mounted as a volume at runtime
FROM deps AS dev
COPY prisma ./prisma/
RUN npx prisma generate
ENV NODE_ENV=development
EXPOSE 3001
# CHOKIDAR_USEPOLLING ensures tsx watch detects changes on Docker Desktop for Windows/Mac
ENV CHOKIDAR_USEPOLLING=true
CMD ["npx", "tsx", "watch", "src/index.ts"]

# Build
FROM deps AS builder
COPY prisma ./prisma/
COPY src ./src
COPY tsconfig.json ./
RUN npm run build
RUN npx prisma generate

# Production image
FROM node:25-alpine AS runner
WORKDIR /app

# Runtime deps only
RUN apk add --no-cache git openssl

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "--enable-source-maps", "dist/index.js"]
