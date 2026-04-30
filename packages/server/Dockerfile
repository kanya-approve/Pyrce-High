# Pyrce Nakama image. Built from the repo root so we can pull
# @pyrce/shared as a workspace dep and bundle the runtime module
# in a multi-stage build.
#
#   docker build -t pyrce-nakama -f packages/server/Dockerfile .
FROM node:22-alpine AS builder
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/server/ packages/server/
RUN pnpm install --frozen-lockfile --filter @pyrce/server... \
  && pnpm --filter @pyrce/shared build \
  && pnpm --filter @pyrce/server build

FROM docker.io/heroiclabs/nakama:3.38.0
COPY --from=builder /repo/packages/server/dist/index.js /nakama/data/modules/index.js
COPY packages/server/nakama.prod.yml /nakama/data/local.yml
