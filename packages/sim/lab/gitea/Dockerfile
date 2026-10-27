# The official Gitea MCP server; the backend is the official Gitea image. Its go.mod asks for Go 1.27.3, which the
# Go command fetches itself (GOTOOLCHAIN=auto) through the module proxy at build time.
FROM mirror.gcr.io/library/golang:1.24-alpine AS build
ARG HTTPS_PROXY
COPY ca.crt /usr/local/share/ca-certificates/lab-proxy.crt
RUN cat /usr/local/share/ca-certificates/lab-proxy.crt >> /etc/ssl/certs/ca-certificates.crt
COPY src /src
WORKDIR /src
RUN HTTPS_PROXY=$HTTPS_PROXY GOTOOLCHAIN=auto CGO_ENABLED=0 go build -o /gitea-mcp .
FROM mirror.gcr.io/library/alpine:3.20
COPY --from=build /gitea-mcp /gitea-mcp
ENTRYPOINT ["/gitea-mcp", "-t", "stdio"]
