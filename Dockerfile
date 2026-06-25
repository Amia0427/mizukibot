FROM node:20-bookworm-slim AS deps

WORKDIR /app

ENV HUSKY=0
ARG NPM_CONFIG_REGISTRY=https://registry.npmmirror.com

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci \
  --registry="$NPM_CONFIG_REGISTRY" \
  && npm prune --omit=dev --registry="$NPM_CONFIG_REGISTRY"

FROM node:20-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
  DATA_DIR=/app/data \
  WEB_BIND_HOST=0.0.0.0 \
  NAPCAT_HTTP_REVERSE_BIND_HOST=0.0.0.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY api ./api
COPY config ./config
COPY core ./core
COPY data/sensitive-words ./assets/sensitive-words
COPY prompts ./prompts
COPY scripts ./scripts
COPY src ./src
COPY utils ./utils
COPY web ./web
COPY index.js package.json package-lock.json .env.example .env.skills.example ./

RUN mkdir -p /app/data /app/logs

EXPOSE 3002 3005

CMD ["npm", "start"]
