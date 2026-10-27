# The official Meilisearch MCP server; the backend is the official Meilisearch image (MEILI_HTTP_ADDR).
FROM mirror.gcr.io/library/python:3.12-slim
ARG HTTPS_PROXY
COPY ca.crt /ca.crt
COPY src /src
RUN HTTPS_PROXY=$HTTPS_PROXY PIP_CERT=/ca.crt pip install --no-cache-dir /src
ENTRYPOINT ["meilisearch-mcp"]
