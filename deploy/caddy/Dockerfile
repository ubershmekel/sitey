FROM node:22-bookworm-slim AS web-builder
WORKDIR /app
COPY web/package*.json ./
RUN npm install
COPY web/ .
RUN npx vite build

FROM caddy:alpine
COPY --from=web-builder /app/dist /srv/web
