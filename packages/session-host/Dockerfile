FROM node:22-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends curl ca-certificates git && rm -rf /var/lib/apt/lists/*

# Session-host infrastructure (not user code)
WORKDIR /app
COPY dist/ ./dist/
COPY package.json ./
RUN npm install --omit=dev

# Agent workspace — setup scripts and spawn commands run here
RUN mkdir /workspace
WORKDIR /workspace

ENV SESSION_HOST_PORT=8080
EXPOSE 8080
CMD ["node", "/app/dist/index.js"]
