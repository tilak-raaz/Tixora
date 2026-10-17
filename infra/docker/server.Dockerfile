# syntax=docker/dockerfile:1
# One image for the API, the worker and the migrate/seed scripts (ADR 0014). They run TypeScript
# through tsx, as in development, so there is no separate build step to drift from what is tested.

FROM node:24-bookworm-slim AS deps
WORKDIR /app
# Every workspace's package.json, so npm can read the lockfile; only the server ones are installed.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/jobs/package.json packages/jobs/
COPY packages/payments/package.json packages/payments/
COPY packages/platform/package.json packages/platform/
COPY packages/shared/package.json packages/shared/
# --ignore-scripts: the root `prepare` script installs git hooks, which a container has no use for.
# tsx compiles with esbuild, whose binary for this platform (@esbuild/linux-*) is an optional
# package; npm skips it silently if the download fails, so check for it in the same step.
RUN npm ci --omit=dev --ignore-scripts --fetch-retries=5 --fetch-retry-maxtimeout=120000 \
     --workspace=@bmt/api --workspace=@bmt/worker \
  && if ! ls -d node_modules/@esbuild/linux-* >/dev/null 2>&1; then \
       echo "esbuild for linux/$(uname -m) was not installed (download failed?); build again" >&2; \
       exit 1; \
     fi \
  && npm cache clean --force

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app ./
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api
COPY apps/worker apps/worker
COPY db db
USER node
EXPOSE 4000
# Compose picks the process; this default runs the API. `node --import tsx` keeps Node itself as
# the main process, so SIGTERM reaches the app's shutdown handler directly.
CMD ["node", "--import", "tsx", "apps/api/src/server.ts"]
