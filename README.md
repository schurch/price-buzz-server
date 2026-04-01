# PriceBuzz

Minimal standalone price tracking app with a split frontend and backend in one repo.

Repo layout:

- `api/`: Fastify API, SQLite access, scraping, notifications, scheduler
- `web/`: React app built with Vite for fast local iteration and hot reload

In production, the Fastify API serves the built React app on the same domain and same origin as `/api/*`.

## Stack

- Node.js 22+
- TypeScript
- Fastify
- React
- Vite
- SQLite via `better-sqlite3`
- `cheerio` and Playwright for scraping

## What It Does

- stores tracked products in SQLite
- checks prices on a schedule
- keeps price history
- supports users, sessions, and admin roles
- verifies account email addresses and uses the account email as the default alert recipient
- lets new users sign up and go straight into the app
- uses the dashboard empty state as the first-item flow
- lets users add more product URLs later from the dashboard
- sends price-drop alerts through email or Telegram when configured

## Local Development

Install dependencies and start both the API and web dev servers:

```bash
npm install
cp .env.example .env
npm run dev
```

Default local ports:

- web: `http://127.0.0.1:5173`
- api: `http://127.0.0.1:4321`

The Vite dev server proxies `/api` to the Fastify API, so the frontend always talks to `/api/...`.

Useful individual commands:

```bash
npm run dev:api
npm run dev:web
npm run build
npm start
```

`npm start` runs the built API, which serves the built `web/dist` bundle if it exists.

For local email verification links, set:

```bash
APP_BASE_URL=http://127.0.0.1:4321
```

That matches the production serving shape, where Fastify is the single public origin.

## Production Run

```bash
npm install
npm run build
npm start
```

## Docker Run

Build the image locally:

```bash
docker build -t pricebuzz .
```

Run it locally with your app env file and a bind mount for SQLite data:

```bash
docker run --rm \
  --env-file .env \
  -e HOST=0.0.0.0 \
  -p 127.0.0.1:4321:4321 \
  -v "$PWD/data:/app/data" \
  pricebuzz
```

The Docker image installs Playwright's Chromium browser in the final runtime image, so browser fallback scraping still works inside the container.

## Environment

Production-oriented example:

```bash
PORT=4321
HOST=127.0.0.1
APP_BASE_URL=https://pricebuzz.app
DATABASE_PATH=./data/app.db
CHECK_INTERVAL_MINUTES=360
PRICE_TRACKER_TIMEOUT=20
PRICE_TRACKER_USER_AGENT=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36
BOOTSTRAP_ADMIN_EMAIL=
BOOTSTRAP_ADMIN_PASSWORD=
RESEND_API_KEY=re_xxxxxxxxx
RESEND_FROM_EMAIL=alerts@pricebuzz.app
TELEGRAM_BOT_TOKEN=
TELEGRAM_BOT_USERNAME=
```

Scrape locale is not configured app-wide. PriceBuzz captures browser language and timezone from the user session and reuses that per user for future checks.

Email alerts require `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, and `APP_BASE_URL` so the app can generate verification links. Telegram alerts require `TELEGRAM_BOT_TOKEN`. For the smoothest connect flow, also set `TELEGRAM_BOT_USERNAME`, then users can generate shareable bot links instead of entering chat IDs manually.

If you want the app to create your initial admin account automatically, set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` before the first startup.

## Reverse Proxy

Run the app on `127.0.0.1:4321` and put Caddy or Nginx in front of it.

Example Caddy config:

```caddyfile
pricebuzz.app {
  reverse_proxy 127.0.0.1:4321
}
```

## Updating

```bash
cd /home/YOUR_USER/pricebuzz
git pull
npm install
npm run build
docker compose pull
docker compose up -d --remove-orphans
docker image prune -af
```

## Notes

- Normal signups are regular users.
- Platform admin access comes from the bootstrap admin env vars.
- There is no dedicated onboarding screen anymore.
- Automatic price detection currently tries common ecommerce selectors, metadata tags, and JSON-LD price data before saving a tracked item.
