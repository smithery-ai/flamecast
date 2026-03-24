FROM node:22-slim

WORKDIR /app

# Install production dependencies
COPY package.json .
RUN npm install --production

# Copy pre-built dist (built by CI or local tsc before docker build)
COPY dist/ ./dist/

# Install common agent tooling so agents can use tsx at runtime
RUN npm install tsx

EXPOSE 8080
ENV BRIDGE_PORT=8080

CMD ["node", "dist/index.js"]
