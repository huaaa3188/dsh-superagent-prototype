# Production Dockerfile for dsh-superagent (Project Aura)
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    NODE_ENV=production \
    PNPM_HOME="/pnpm" \
    PATH="/root/.local/bin:/pnpm:/usr/local/bin:/usr/bin:/bin"

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    jq \
    procps \
    python3 \
    ripgrep \
    tmux \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

WORKDIR /app

# Install dependencies and build the Cordis plugin bundle
COPY package.json pnpm-lock.yaml tsdown.config.ts tsconfig.json ./
RUN pnpm install --frozen-lockfile

COPY src ./src
COPY web ./web
COPY skills ./skills
COPY scripts ./scripts
COPY examples ./examples
COPY docs ./docs
COPY README.md SETUP.md cordis.patch.yml ./

RUN pnpm build \
  && chmod +x /app/scripts/dsh-superagent /app/scripts/aura-cli/* \
  && ln -sf /app/scripts/aura-cli/tg-cli /usr/local/bin/tg-cli \
  && ln -sf /app/scripts/aura-cli/gcal-cli /usr/local/bin/gcal-cli \
  && ln -sf /app/scripts/aura-cli/mail-cli /usr/local/bin/mail-cli \
  && ln -sf /app/scripts/aura-cli/tavily-cli /usr/local/bin/tavily-cli \
  && ln -sf /app/scripts/aura-cli/aura-kb /usr/local/bin/aura-kb \
  && ln -sf /app/scripts/aura-cli/aura-cron /usr/local/bin/aura-cron \
  && mkdir -p /root/.dsh /root/.config/tg-bot /root/.config/aura-agent

EXPOSE 3082

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD python3 /app/scripts/dsh-superagent --profile ${DSH_SUPERAGENT_PROFILE:-superagent} --url http://127.0.0.1:3082 status || [ $? -eq 3 ]

STOPSIGNAL SIGINT

CMD ["dsh", "--profile", "superagent", "--no-open"]
