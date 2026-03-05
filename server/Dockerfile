FROM node:20-alpine AS base
WORKDIR /app

# Install build tools for native modules (argon2)
RUN apk add --no-cache python3 make g++ git

# Dependencies
FROM base AS deps
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci

# Build
FROM deps AS builder
COPY src ./src
COPY tsconfig.json ./
RUN npm run build
RUN npx prisma generate

# Production image
FROM node:20-alpine AS runner
WORKDIR /app

# Runtime deps only
RUN apk add --no-cache git

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "dist/index.js"]
