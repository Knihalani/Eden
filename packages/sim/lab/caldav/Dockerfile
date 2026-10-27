# A CalDAV MCP server; the backend is Radicale (../radicale), reached as CALDAV_URL. Its `mcp>=…` dependency is
# unpinned and mcp 2 removed the decorator API it uses, so mcp is held below 2.
FROM mirror.gcr.io/library/python:3.12-slim
ARG HTTPS_PROXY
COPY ca.crt /ca.crt
COPY src /src
RUN HTTPS_PROXY=$HTTPS_PROXY PIP_CERT=/ca.crt pip install --no-cache-dir /src "mcp<2"
ENTRYPOINT ["mcp-caldav"]
