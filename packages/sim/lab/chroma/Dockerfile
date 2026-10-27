# The official Chroma MCP server over an embedded (persistent) Chroma store mounted at /data. The default embedding
# model is downloaded at build time: at run time the container has no network. seed.py loads a world with the same
# client and model. It pins mcp==1.6.0, which imports a pydantic internal removed in pydantic 2.11, so pydantic is held
# below 2.11.
FROM mirror.gcr.io/library/python:3.12-slim
ARG HTTPS_PROXY
COPY ca.crt /ca.crt
COPY src /src
RUN HTTPS_PROXY=$HTTPS_PROXY PIP_CERT=/ca.crt pip install --no-cache-dir /src "pydantic<2.11"
RUN HTTPS_PROXY=$HTTPS_PROXY REQUESTS_CA_BUNDLE=/ca.crt SSL_CERT_FILE=/ca.crt python -c \
  "from chromadb.utils.embedding_functions import DefaultEmbeddingFunction as D; print(len(D()(['warm up'])[0]))"
COPY seed.py /seed.py
ENTRYPOINT ["chroma-mcp", "--client-type", "persistent", "--data-dir", "/data"]
