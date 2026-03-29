FROM node:22-bookworm-slim AS build

WORKDIR /app

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN npx playwright install --with-deps chromium && \
  rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/data

EXPOSE 4321

CMD ["node", "dist/server.js"]
