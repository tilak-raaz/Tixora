# syntax=docker/dockerfile:1
# The Next.js app as a standalone server: the build traces only the files it needs (ADR 0014).

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/jobs/package.json packages/jobs/
COPY packages/payments/package.json packages/payments/
COPY packages/platform/package.json packages/platform/
COPY packages/shared/package.json packages/shared/
# The build needs dev dependencies (TypeScript, Tailwind); none of them reach the final image.
# npm skips an optional package without failing when its download fails, and Next's compiler for
# this platform is one (@next/swc-linux-*-gnu: the image uses glibc). Check for it in the same
# step, so a flaky download fails the build here instead of being cached and breaking
# `next build` later.
RUN npm ci --ignore-scripts --fetch-retries=5 --fetch-retry-maxtimeout=120000 \
  && if ! ls -d node_modules/@next/swc-linux-*-gnu >/dev/null 2>&1; then \
       echo "Next.js compiler for linux/$(uname -m) was not installed (download failed?); build again" >&2; \
       exit 1; \
     fi
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
# The /api rewrite in next.config.ts is fixed at build time. nginx answers /api/* before it reaches
# Next.js, so this only matters if something calls the web container directly.
ARG API_URL=http://nginx:8081
ENV API_URL=$API_URL NEXT_OUTPUT=standalone NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @bmt/web

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
