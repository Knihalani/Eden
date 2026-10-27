# Basic Memory over a folder of Markdown notes: HOME is /state, so its default project is /state/basic-memory. The lab
# indexes the notes into SQLite FTS5 (`basic-memory reindex`) before starting the server.
FROM mirror.gcr.io/library/python:3.12-slim
ARG HTTPS_PROXY
COPY ca.crt /ca.crt
COPY src /src
RUN HTTPS_PROXY=$HTTPS_PROXY PIP_CERT=/ca.crt pip install --no-cache-dir /src
ENV HOME=/state
ENTRYPOINT ["basic-memory", "mcp"]
