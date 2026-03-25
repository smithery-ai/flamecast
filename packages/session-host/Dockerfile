FROM node:22-slim
WORKDIR /app
COPY packages/session-host/dist/ ./dist/
COPY packages/session-host/package.json ./
RUN npm install --omit=dev
ENV SESSION_HOST_PORT=8080
EXPOSE 8080
CMD ["node", "dist/index.js"]
