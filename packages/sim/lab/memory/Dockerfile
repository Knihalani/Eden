# The reference knowledge-graph memory server. Its store is one JSONL file, mounted at /data.
FROM mirror.gcr.io/library/node:24-slim
ARG HTTPS_PROXY
COPY ca.crt /ca.crt
COPY src /src
WORKDIR /src/src/memory
RUN export NODE_EXTRA_CA_CERTS=/ca.crt npm_config_cafile=/ca.crt npm_config_https_proxy=$HTTPS_PROXY \
  && npm install --no-audit --no-fund --ignore-scripts && npm install --no-audit --no-fund typescript@5 \
  && npx tsc -p .
ENV MEMORY_FILE_PATH=/data/memory.jsonl
ENTRYPOINT ["node", "/src/src/memory/dist/index.js"]
