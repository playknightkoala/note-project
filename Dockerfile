# syntax=docker/dockerfile:1
# Single runtime image: Node serves the SPA and the API; SQLite + files live in /data (a named volume).
FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-fund --no-audit
COPY tsconfig.json tsconfig.server.json tsconfig.client.json vite.config.ts index.html ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/data NODE_OPTIONS=--disable-warning=ExperimentalWarning
# The server is bundled (esbuild) so no node_modules are shipped; only the built client and server files.
COPY --from=build /src/dist ./dist
COPY --from=build /src/package.json ./package.json
RUN mkdir -p /data && chown 101:101 /data
USER 101:101
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "dist/server/index.js"]
