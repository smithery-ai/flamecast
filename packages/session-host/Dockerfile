FROM node:22-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY dist/ ./dist/
RUN npm init -y && npm install @agentclientprotocol/sdk ws
ENV SESSION_HOST_PORT=8080
EXPOSE 8080
CMD ["node", "dist/index.js"]
