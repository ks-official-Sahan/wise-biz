# One image recipe for the Node services (api, workers, realtime).
#   docker build -f infra/docker/service.Dockerfile --build-arg APP=api -t wise-biz/api .
# Node 24 runs the TypeScript sources directly, so there is no compile step. Workspace packages stay symlinked (not
# copied by `pnpm deploy`): Node refuses to strip types from files under node_modules.
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-slim AS deps
ARG APP
ENV PNPM_HOME=/pnpm CI=true
RUN corepack enable
WORKDIR /repo
COPY . .
# Production dependencies of this app and of the workspace packages it uses, from the lockfile only.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@wise-biz/${APP}..." --ignore-scripts

FROM node:${NODE_VERSION}-slim AS run
ARG APP
# HTTP port to probe and expose: 3001 api, 3002 realtime (also set REALTIME_PORT at runtime), empty for workers.
ARG PORT=3001
ENV NODE_ENV=production APP=${APP} HEALTH_PORT=${PORT}
WORKDIR /repo
COPY --from=deps --chown=node:node /repo /repo
# The services only run `node`. npm and corepack ship their own copies of undici and brace-expansion, which the HIGH and
# CRITICAL image scan flags (v0.2.0 run); removing them leaves nothing to patch and a smaller image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
# Non-root, read-only root filesystem (run with --read-only; /tmp is the only writable path).
USER node
WORKDIR /repo/apps/${APP}
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "const p=process.env.HEALTH_PORT;if(!p)process.exit(0);fetch('http://127.0.0.1:'+p+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/main.ts"]
