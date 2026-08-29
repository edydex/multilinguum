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
    && pnpm deploy --legacy --filter @multilinguum/processor --prod /output \
    && rm /output/node_modules/@multilinguum/protocol \
    && mkdir -p /output/node_modules/@multilinguum/protocol \
    && cp packages/protocol/package.json /output/node_modules/@multilinguum/protocol/package.json \
    && cp -R packages/protocol/dist /output/node_modules/@multilinguum/protocol/dist

FROM node:24-bookworm-slim
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg poppler-utils \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home multilinguum \
    && mkdir -p /var/lib/multilinguum/archives \
    && chown -R multilinguum:multilinguum /var/lib/multilinguum
WORKDIR /app
COPY --from=build --chown=multilinguum:multilinguum /output ./
RUN node --input-type=module -e "await import('@multilinguum/protocol')"
USER multilinguum
EXPOSE 4310
CMD ["node", "dist/main.js"]
