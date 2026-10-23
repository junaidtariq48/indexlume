FROM node:24.19.0-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
  && apt-get upgrade --yes \
  && apt-get install --yes --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*
RUN npm install --global npm@12.2.1 pnpm@10.34.5

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/ingestion/package.json packages/ingestion/package.json
COPY packages/ts-client/package.json packages/ts-client/package.json

RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .

ARG DATABASE_URL=postgresql://open_search_console:build-only@postgres:5432/open_search_console
ENV DATABASE_URL=$DATABASE_URL

ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

RUN pnpm build

RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
  && pnpm install --prod --frozen-lockfile --offline --ignore-scripts \
  && mkdir /runtime \
  && cp -RP /app/. /runtime/ \
  && rm -f /runtime/pnpm-lock.yaml

FROM debian:bookworm-slim AS runtime

LABEL org.opencontainers.image.title="Indexlume" \
  org.opencontainers.image.vendor="Oryxsol" \
  org.opencontainers.image.licenses="Apache-2.0"

ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
  && apt-get upgrade --yes \
  && apt-get install --yes --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /usr/local/LICENSE /usr/local/share/licenses/node/LICENSE

WORKDIR /app
COPY --from=build /runtime /app
