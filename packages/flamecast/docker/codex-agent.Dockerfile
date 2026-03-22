FROM node:22-slim

WORKDIR /app

RUN apt-get update && apt-get install -y socat && rm -rf /var/lib/apt/lists/*
RUN npm install -g @zed-industries/codex-acp

COPY docker/tcp-bridge.sh /usr/local/bin/tcp-bridge
RUN chmod +x /usr/local/bin/tcp-bridge

EXPOSE 9100

CMD ["sh", "-c", "rm -rf /root/.codex/skills && exec tcp-bridge codex-acp"]
