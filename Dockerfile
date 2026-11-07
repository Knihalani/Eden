# Eden's HTTP server (D280). Build and run from the repo root:
#   docker build -t eden .
#   docker run -p 8790:8790 -e EDEN_API_KEYS="acme:<a key of 16+ characters>" -e EDEN_PROCESSES=2 \
#     -v eden-data:/data eden
# Add -e OPENROUTER_API_KEY=… for the model roles, -v ./sources:/sources:ro with EDEN_USER_SOURCES_FILE or
# EDEN_SOURCES_FILE for connectors. Set EDEN_PROCESSES to the container's CPU quota: a quota the container cannot see
# is not detected (docs/INTEGRATION.md, "Processes and per-tenant caps").
FROM oven/bun:1.4.4
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY examples ./examples
# The "default minus a part" profiles, for EDEN_ENGINE_CONFIG=docs/profiles/minus-<part>.json.
COPY docs/profiles ./docs/profiles
# Only the server's runtime dependencies (the MCP SDK, zod, re2js); no lab, no dev tools.
RUN bun install --frozen-lockfile --production
# The source map (entity names and counts, never content, D8) persists in EDEN_HOME; item text stays in memory.
ENV HOST=0.0.0.0 PORT=8790 EDEN_HOME=/data NODE_ENV=production
RUN mkdir -p /data && chown bun:bun /data
VOLUME /data
USER bun
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --start-interval=2s \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8790) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["bun", "packages/server/src/main.ts"]
