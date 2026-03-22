FROM node:22-slim

WORKDIR /app

# Install dependencies locally so tsx can resolve them
RUN npm init -y && npm install tsx @agentclientprotocol/sdk

# Copy the example agent
COPY src/flamecast/agent.ts ./agent.ts

EXPOSE 9100

CMD ["npx", "tsx", "agent.ts"]
