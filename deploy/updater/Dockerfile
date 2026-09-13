# Pinned so rebuilds are reproducible; bump deliberately.
FROM docker:29.8.0-cli
RUN apk add --no-cache git ca-certificates
CMD ["sh", "-c", "echo 'sitey-updater: dormant container. Triggered by sitey-api via docker exec.' && sleep infinity"]
