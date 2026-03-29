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

The app runs on `http://localhost:4321` by default.

For local email verification links, set `APP_BASE_URL=http://127.0.0.1:4321` in your local `.env`.

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

For local development, the most important override is:

```bash
APP_BASE_URL=http://127.0.0.1:4321
```

Scrape locale is not configured app-wide. PriceBuzz captures browser language and timezone from the user session and reuses that per user for future checks.

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
2. Clone the repo into your app directory, for example `/home/YOUR_USER/pricebuzz`.
3. Create `.env`.
4. Run `npm install`.
5. Run `npm run build`.
6. Copy `systemd/pricebuzz.service` to `/etc/systemd/system/pricebuzz.service`.
7. The checked-in unit is a template. Update `WorkingDirectory`, `EnvironmentFile`, and `ExecStart` to match your deploy path and your Node 22 binary.
8. Enable and start the service.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pricebuzz
sudo systemctl status pricebuzz
```

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
sudo systemctl restart pricebuzz
```

## GitHub Deploys

This repo includes a GitHub Actions workflow at `.github/workflows/deploy.yml` that builds a Docker image on every push to `main`, pushes it to Docker Hub, copies the deploy files to the server, and tells the server to pull and restart it with Docker Compose.

Required GitHub Actions secrets:

- `DEPLOY_HOST`: your server hostname or IP
- `DEPLOY_USER`: your SSH user
- `DEPLOY_PATH`: your deploy path, for example `/home/YOUR_USER/pricebuzz`
- `DEPLOY_SSH_KEY`: a private SSH key that can log into the server
- `DOCKER_HUB_USERNAME`: your Docker Hub username
- `DOCKER_HUB_PASSWORD`: a Docker Hub access token or password

Server prerequisites for that workflow:

- the app directory already exists on the server
- `.env` already exists on the server and is not managed by the workflow
- Docker and Docker Compose are installed on the server
- the deploy user can run Docker commands
- a writable `data/` directory exists in the deploy path

The workflow does this:

1. builds a Docker image
2. pushes it to Docker Hub
3. copies `compose.yaml` and `scripts/deploy.sh` to the server
4. runs the deploy script on the server
5. pulls the new image with Docker Compose
6. starts or replaces the running container

Recommended VPS setup:

```bash
mkdir -p /home/YOUR_USER/pricebuzz/data
cp .env /home/YOUR_USER/pricebuzz/.env
cp compose.yaml /home/YOUR_USER/pricebuzz/compose.yaml
mkdir -p /home/YOUR_USER/pricebuzz/scripts
```

The checked-in `compose.yaml` expects `IMAGE_NAME` to be set when you run Docker Compose. The workflow sets that automatically.

## Notes

- Normal signups are regular users.
- Platform admin access comes from the bootstrap admin env vars.
- After signup, users land on an onboarding screen where they can add their first tracked item or skip to the dashboard.
- Automatic price detection currently tries common ecommerce selectors, metadata tags, and JSON-LD price data before saving a tracked item.
