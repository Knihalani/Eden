# An IMAP MCP server; the backend is the official Dovecot image. Credentials come from IMAP_MCP_ACCOUNT_* variables
# and IMAP_MCP_READ_ONLY=1 registers only its read tools.
FROM mirror.gcr.io/library/node:24-slim
ARG HTTPS_PROXY
COPY ca.crt /ca.crt
COPY src /src
WORKDIR /src
RUN export NODE_EXTRA_CA_CERTS=/ca.crt npm_config_cafile=/ca.crt npm_config_https_proxy=$HTTPS_PROXY \
  && npm ci --no-audit --no-fund --ignore-scripts && npm run build
ENTRYPOINT ["node", "/src/dist/index.js"]
