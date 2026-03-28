# PriceBuzz

Minimal standalone TypeScript price tracking app for a single server.

The app is intentionally small:

- one Node.js process
- one SQLite database file
- one server-rendered web UI
- one in-process scheduler
- one `systemd` service in production

## Stack

- Node.js 20+
- TypeScript
- Fastify
- SQLite via `better-sqlite3`
- `cheerio` for HTML parsing

## What It Does

- stores tracked products in SQLite
- checks prices on a schedule
- keeps price history
- supports users, sessions, and admin roles
- collects first and last name during signup
- separates the public site, user app, and platform admin
- verifies account email addresses and uses the account email as the default alert recipient
- sends new users through a dedicated onboarding step to add their first product URL, with automatic price detection
- lets users add more product URLs later from the dashboard
- sends price-drop alerts through email or Telegram when configured

## Local Development

```bash
npm install
cp .env.example .env
npm run dev
```

The app runs on `http://localhost:3000` by default.

For local email verification links, set `APP_BASE_URL=http://127.0.0.1:3000` in your local `.env`.

## Production Run

```bash
npm install
npm run build
npm start
```

## Environment

Production-oriented example:

```bash
PORT=3000
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

For local development, the most important override is:

```bash
APP_BASE_URL=http://127.0.0.1:3000
```

Email alerts require `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, and `APP_BASE_URL` so the app can generate verification links. Telegram alerts require `TELEGRAM_BOT_TOKEN`. For the smoothest connect flow, also set `TELEGRAM_BOT_USERNAME`, then users can generate shareable bot links instead of entering chat IDs manually.

For Resend API, the typical setup is:

```bash
RESEND_API_KEY=re_xxxxxxxxx
RESEND_FROM_EMAIL=alerts@pricebuzz.app
```

Replace `re_xxxxxxxxx` with your real Resend API key.

If you want the app to create your initial admin account automatically, set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` before the first startup.

## Deploy Without Docker

1. Install Node.js 20+ on the server.
2. Clone the repo into `/srv/pricebuzz`.
3. Create `.env`.
4. Run `npm install`.
5. Run `npm run build`.
6. Copy `systemd/pricebuzz.service` to `/etc/systemd/system/pricebuzz.service`.
7. The checked-in unit assumes the app lives at `/srv/pricebuzz`. Adjust the paths only if you deploy somewhere else.
8. Enable and start the service.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pricebuzz
sudo systemctl status pricebuzz
```

## Reverse Proxy

Run the app on `127.0.0.1:3000` and put Caddy or Nginx in front of it.

Example Caddy config:

```caddyfile
pricebuzz.app {
  reverse_proxy 127.0.0.1:3000
}
```

## Updating

```bash
cd /srv/pricebuzz
git pull
npm install
npm run build
sudo systemctl restart pricebuzz
```

## Notes

- Normal signups are regular users.
- Platform admin access comes from the bootstrap admin env vars.
- After signup, users land on an onboarding screen where they can add their first tracked item or skip to the dashboard.
- Automatic price detection currently tries common ecommerce selectors, metadata tags, and JSON-LD price data before saving a tracked item.
