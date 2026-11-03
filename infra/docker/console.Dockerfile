# The operator console (Next.js). API_ORIGIN is compiled into the /v1 rewrite, so it is a build argument.
#   docker build -f infra/docker/console.Dockerfile --build-arg API_ORIGIN=http://api:3001 -t wise-biz/console .
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-slim AS build
ARG API_ORIGIN=http://api:3001
ENV PNPM_HOME=/pnpm CI=true NEXT_TELEMETRY_DISABLED=1 API_ORIGIN=${API_ORIGIN}
RUN corepack enable
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@wise-biz/console..." --ignore-scripts
RUN pnpm --filter @wise-biz/console build

FROM node:${NODE_VERSION}-slim AS run
ARG API_ORIGIN=http://api:3001
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 API_ORIGIN=${API_ORIGIN} HEALTH_PORT=3000
WORKDIR /repo
COPY --from=build --chown=node:node /repo /repo
# Non-root. Next writes its cache under .next/cache: mount a tmpfs there when running with --read-only.
USER node
WORKDIR /repo/apps/console
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/sign-in').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["pnpm", "exec", "next", "start", "--port", "3000"]
