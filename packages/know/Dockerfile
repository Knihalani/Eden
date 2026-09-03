FROM oven/bun:1.2-debian
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip \
  && unzip -q /tmp/awscliv2.zip -d /tmp \
  && /tmp/aws/install \
  && rm -rf /tmp/aws /tmp/awscliv2.zip /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV EDEN_KNOW_DIR=/data/know \
    PORT=8080 \
    EDEN_KNOW_INTERVAL=45 \
    EDEN_KNOW_CC=0 \
    EDEN_KNOW_LIVE=24 \
    EDEN_KNOW_NEWS=8 \
    EDEN_KNOW_WET_EVERY=3 \
    EDEN_KNOW_CC_SLICES=1 \
    EDEN_KNOW_LIVE_CONC=6
EXPOSE 8080
VOLUME ["/data/know"]
CMD ["bun", "src/worker.ts"]
