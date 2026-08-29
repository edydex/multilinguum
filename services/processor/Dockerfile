FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY services/processor/package.json services/processor/package.json
RUN pnpm install --frozen-lockfile --filter @multilinguum/protocol --filter @multilinguum/processor
COPY packages/protocol packages/protocol
COPY services/processor services/processor
RUN pnpm --filter @multilinguum/protocol build \
    && pnpm --filter @multilinguum/processor build \
    && pnpm deploy --filter @multilinguum/processor --prod /output

FROM node:24-bookworm-slim
ENV NODE_ENV=production
RUN useradd --system --uid 10001 --create-home multilinguum \
    && mkdir -p /var/lib/multilinguum/archives \
    && chown -R multilinguum:multilinguum /var/lib/multilinguum
WORKDIR /app
COPY --from=build --chown=multilinguum:multilinguum /output ./
USER multilinguum
EXPOSE 4310
CMD ["node", "dist/main.js"]
