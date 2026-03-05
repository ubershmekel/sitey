FROM node:25-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL

RUN npx vite build

# One-shot init container: copies built files into the shared volume on startup
FROM alpine:3
COPY --from=builder /app/dist /dist
CMD ["cp", "-r", "/dist/.", "/srv/"]
