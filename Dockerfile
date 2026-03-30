FROM node:22-bookworm-slim AS build

WORKDIR /app

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
COPY api/package.json api/package.json
COPY web/package.json web/package.json
RUN npm ci

COPY api ./api
COPY web ./web
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/api/package.json ./api/package.json
COPY --from=build /app/web/package.json ./web/package.json
COPY --from=build /app/api/dist ./api/dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/node_modules ./node_modules

RUN npx playwright install --with-deps chromium && \
  rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/data

EXPOSE 4321

CMD ["node", "api/dist/server.js"]
