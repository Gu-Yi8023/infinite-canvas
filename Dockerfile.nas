FROM oven/bun:1.3.13 AS web-build
WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
RUN bun run build

FROM node:24-bookworm-slim AS agent-build
WORKDIR /app/canvas-agent
COPY canvas-agent/package.json canvas-agent/package-lock.json ./
RUN npm ci --ignore-scripts
COPY canvas-agent ./
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates bubblewrap \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/canvas-agent
COPY --from=agent-build /app/canvas-agent/package.json ./package.json
COPY --from=agent-build /app/canvas-agent/node_modules ./node_modules
RUN install -m 755 node_modules/@openai/codex-linux-*/vendor/*/bin/codex /usr/local/bin/codex-linux-sandbox
COPY --from=agent-build /app/canvas-agent/dist ./dist
COPY canvas-agent/agent-instructions.md ./agent-instructions.md
COPY deploy/nas/setup.mjs ./scripts/nas-setup.mjs
COPY deploy/nas/diagnose.mjs ./scripts/nas-diagnose.mjs
COPY deploy/nas/entrypoint.sh /usr/local/bin/canvas-nas
RUN chmod 755 /usr/local/bin/canvas-nas
ENV PATH="/app/canvas-agent/node_modules/.bin:${PATH}" NAS_MODE=true
USER node
ENTRYPOINT ["canvas-nas"]
CMD ["worker"]

FROM runtime AS gateway
COPY --from=web-build /app/web/dist /app/web/dist
ENV CANVAS_WEB_ROOT=/app/web/dist
CMD ["gateway"]
