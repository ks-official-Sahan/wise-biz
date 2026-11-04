# The operator console (Next.js). API_ORIGIN (where /v1 is proxied to) is read at run time: set it on the container.
#   docker build -f infra/docker/console.Dockerfile -t wise-biz/console .  &&  docker run -e API_ORIGIN=http://api:3001 wise-biz/console
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-slim AS build
ENV PNPM_HOME=/pnpm CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@wise-biz/console..." --ignore-scripts
RUN pnpm --filter @wise-biz/console build

FROM node:${NODE_VERSION}-slim AS run
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HEALTH_PORT=3000
WORKDIR /repo
COPY --from=build --chown=node:node /repo /repo
# Non-root. Next writes its cache under .next/cache: mount a tmpfs there when running with --read-only.
USER node
WORKDIR /repo/apps/console
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/sign-in').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["pnpm", "exec", "next", "start", "--port", "3000"]
