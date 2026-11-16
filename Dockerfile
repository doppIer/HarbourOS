# ---- build web ----
FROM node:22-bookworm-slim AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm install --no-audit --no-fund
COPY web ./
COPY server/src/protocol.ts /app/server/src/protocol.ts
COPY config /app/config
RUN npm run build

# ---- build server (native deps: better-sqlite3, node-pty) ----
FROM node:22-bookworm-slim AS server
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package*.json ./
RUN npm install --no-audit --no-fund
COPY server ./
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=server /app/server/node_modules ./node_modules
COPY --from=server /app/server/dist ./dist
COPY --from=web /app/web/dist ./public
COPY defaults ./defaults
COPY --chmod=755 entrypoint.sh /usr/local/bin/harbour-entrypoint
ENV NODE_ENV=production PORT=7080 PUBLIC_DIR=/app/public DEFAULTS_DIR=/app/defaults \
    NODE_OPTIONS=--max-old-space-size=96
EXPOSE 7080
# Runs as root only long enough to give /data to the "node" user, then drops to it.
ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/harbour-entrypoint"]
CMD ["node","dist/index.js"]
