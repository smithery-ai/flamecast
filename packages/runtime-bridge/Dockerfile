FROM node:22

WORKDIR /app

# Install production dependencies for the runtime-bridge
COPY package.json .
RUN npm install --production

# Copy pre-built dist (built by CI or local tsc before docker build)
COPY dist/ ./dist/

# Install common agent tooling so TypeScript agents can run via tsx
RUN npm install tsx @agentclientprotocol/sdk

# Pre-cache heavy agent deps so setup commands are near-instant.
# Setup still runs but finds everything already installed.
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends libssl3 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @zed-industries/codex-acp

EXPOSE 8080
ENV BRIDGE_PORT=8080

CMD ["node", "dist/index.js"]
