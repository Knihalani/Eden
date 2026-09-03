FROM oven/bun:1.2-debian
RUN apt-get update \
  && apt-get install -y --no-install-recommends awscli ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV EDEN_KNOW_DIR=/data/know \
    PORT=8080 \
    EDEN_KNOW_INTERVAL=30 \
    EDEN_KNOW_CC=80 \
    EDEN_KNOW_LIVE=48 \
    EDEN_KNOW_NEWS=8 \
    EDEN_KNOW_CC_SLICES=2 \
    EDEN_KNOW_LIVE_CONC=12
EXPOSE 8080
VOLUME ["/data/know"]
CMD ["bun", "src/worker.ts"]
