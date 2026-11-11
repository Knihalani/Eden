# Eden's HTTP server (D280). Build and run from the repo root:
#   docker build -t eden .
#   docker run -p 8790:8790 -e EDEN_API_KEYS="acme:$(openssl rand -hex 24)" -e EDEN_PROCESSES=2 \
#     -v eden-data:/data eden
# (keep the key: callers send it as Authorization: Bearer <key>; one tenant:key pair per tenant, comma-separated).
# Add -e OPENROUTER_API_KEY=… for the model roles. Connectors: -v ./sources:/sources:ro
# -e EDEN_USER_SOURCES_FILE=/sources/users.json (a path inside the container), plus -e for each token variable the
# file names; it is re-read on change. A configuration mistake stops startup with an `eden:` line naming it (exit 2).
# Set EDEN_PROCESSES to the container's CPU quota: a quota the container cannot see is not detected
# (docs/INTEGRATION.md, "Processes and per-tenant caps").
FROM oven/bun:1.4.4
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json tsconfig.base.json ./
# bunfig.toml preloads this into every `bun` started here, the server included: without it nothing starts
# (scripts/dockerfile.test.ts checks every preload is copied).
COPY scripts/lab-guard.ts ./scripts/lab-guard.ts
COPY packages ./packages
COPY examples ./examples
# The "default minus a part" profiles, for EDEN_ENGINE_CONFIG=docs/profiles/minus-<part>.json.
COPY docs/profiles ./docs/profiles
# Only the server's runtime dependencies (the MCP SDK, zod, re2js); no lab, no dev tools.
# Behind a TLS-inspecting proxy, pass its CA for this step only (never baked into the image):
#   docker build --secret id=ca,src=/path/to/ca.pem -t eden .
RUN --mount=type=secret,id=ca,required=false \
  if [ -s /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
  bun install --frozen-lockfile --production
# The source map (entity names and counts, never content, D8) persists in EDEN_HOME; item text stays in memory.
# Opt-in (D425): -e EDEN_PERSIST_FROZEN_DIR=/data/frozen -e EDEN_PERSIST_KEY=<openssl rand -hex 32> keeps idle
# users across restarts, encrypted on disk (docs/INTEGRATION.md, "Restarts without a full re-sync").
ENV HOST=0.0.0.0 PORT=8790 EDEN_HOME=/data NODE_ENV=production
RUN mkdir -p /data && chown bun:bun /data
VOLUME /data
USER bun
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --start-interval=2s \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8790) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["bun", "packages/server/src/main.ts"]
