# mcpvault over an Obsidian-style vault (a folder of Markdown), mounted at /vault, started read-only.
FROM mirror.gcr.io/library/node:24-slim
ARG HTTPS_PROXY
COPY ca.crt /ca.crt
COPY src /src
WORKDIR /src
RUN export NODE_EXTRA_CA_CERTS=/ca.crt npm_config_cafile=/ca.crt npm_config_https_proxy=$HTTPS_PROXY \
  && npm install --no-audit --no-fund --ignore-scripts && npm run build
ENTRYPOINT ["node", "/src/dist/server.js", "/vault", "--read-only"]
