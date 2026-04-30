# Pyrce game-server image — runs inside an Agones-managed GameServer pod.
# Built from the workspace root so it can pull the @pyrce/shared workspace
# package and the Agones SDK from the lockfile.
#
# Builder runs natively (`$BUILDPLATFORM`) — TS → JS is arch-agnostic, so
# we skip QEMU there. The runtime image targets `$TARGETPLATFORM` so the
# native node binary + the agones-sdk gRPC native deps match the cluster
# arch. Built for amd64 + arm64.
FROM --platform=$BUILDPLATFORM node:22-alpine AS builder
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/game-server/ packages/game-server/
RUN pnpm install --frozen-lockfile --filter @pyrce/game-server... \
  && pnpm --filter @pyrce/shared build \
  && pnpm --filter @pyrce/game-server build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=builder /repo/pnpm-lock.yaml /repo/pnpm-workspace.yaml /repo/package.json ./
COPY --from=builder /repo/packages/shared/ packages/shared/
COPY --from=builder /repo/packages/game-server/ packages/game-server/
RUN pnpm install --prod --frozen-lockfile --filter @pyrce/game-server...
USER node
EXPOSE 7777
CMD ["node", "packages/game-server/dist/index.js"]
