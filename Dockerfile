# Keepsake: one image for HomersLab and standalone (ADR 0001). Runs as `node`, needs no writable root (/data and
# /keys are its volumes, the key that seals the draws in /keys, never in /data; compose mounts the root read-only).
ARG NODE_IMAGE=node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

FROM ${NODE_IMAGE} AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @keepsake/web build \
 && pnpm --filter @keepsake/server build \
 && pnpm --filter @keepsake/server deploy --prod --legacy /out \
 && cp -r apps/server/dist apps/server/drizzle /out/ \
 && cp -r apps/web/dist /out/web

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    KEEPSAKE_HOST=0.0.0.0 KEEPSAKE_PORT=8080 \
    KEEPSAKE_DATA_DIR=/data KEEPSAKE_KEYS_DIR=/keys KEEPSAKE_WEB_DIR=/app/web KEEPSAKE_MIGRATIONS_DIR=/app/drizzle
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /out/drizzle ./drizzle
COPY --from=build /out/web ./web
COPY LICENSE NOTICE ./
# `docker exec <container> keepsake admins` and `keepsake recover <admin id>` (a lost admin's one-time link)
RUN printf '#!/bin/sh\nexec node /app/dist/cli.js "$@"\n' > /usr/local/bin/keepsake && chmod 755 /usr/local/bin/keepsake
RUN mkdir -p /data /keys && chown node:node /data /keys && chmod 700 /data /keys
USER node
VOLUME /data /keys
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
