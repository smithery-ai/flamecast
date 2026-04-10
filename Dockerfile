FROM golang:1.24-bookworm AS go

FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH=/root/.local/bin:/usr/local/go/bin:${PATH}
ENV SESSION_HOST_BINARY=/opt/flamecast/packages/session-host-go/dist/session-host-native

COPY --from=go /usr/local/go /usr/local/go
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint

RUN chmod +x /usr/local/bin/docker-entrypoint \
  && apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl gnupg \
  && mkdir -p --mode=0755 /usr/share/keyrings \
  && curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
    | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null \
  && echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
    > /etc/apt/sources.list.d/cloudflared.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends cloudflared \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://claude.ai/install.sh | bash \
  && ln -sf /root/.local/bin/claude /usr/local/bin/claude \
  && npm install -g @openai/codex \
  && corepack enable

WORKDIR /opt/flamecast

COPY . .

RUN pnpm install --frozen-lockfile \
  && pnpm --filter @flamecast/session-host-go run build:go \
  && pnpm turbo run build:package --filter=flamecast... \
  && printf '%s\n' '#!/usr/bin/env bash' 'exec node /opt/flamecast/packages/cli/dist/cli.js "$@"' \
    > /usr/local/bin/flamecast \
  && chmod +x /usr/local/bin/flamecast

WORKDIR /workspace

EXPOSE 3001

ENTRYPOINT ["docker-entrypoint"]
