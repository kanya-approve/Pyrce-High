# Pyrce client — Vite-built static bundle served by nginx. Build from
# the repo root so the workspace can resolve @pyrce/shared.
#
#   docker build -t pyrce-client -f packages/client/Dockerfile .
FROM node:22-alpine AS builder
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/client/ packages/client/
RUN pnpm install --frozen-lockfile --filter @pyrce/client... \
  && pnpm --filter @pyrce/shared build \
  && pnpm --filter @pyrce/client build

FROM nginx:1.27-alpine
COPY --from=builder /repo/packages/client/dist/ /usr/share/nginx/html/
# SPA fallback so deep links resolve to index.html.
RUN printf 'server {\n  listen 8080;\n  root /usr/share/nginx/html;\n  location / { try_files $uri $uri/ /index.html; }\n}\n' > /etc/nginx/conf.d/default.conf \
  && rm /etc/nginx/conf.d/default.conf.bak 2>/dev/null || true
EXPOSE 8080
