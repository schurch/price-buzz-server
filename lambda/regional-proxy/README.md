# Regional Proxy Lambda

This Lambda is intentionally simple. It does not parse prices. It only fetches HTML from a specific region and returns the result back to the server.

Supported modes:

- `http`: plain `fetch()`
- `browser`: Playwright + Chromium

Suggested handler:

- file: `index.mjs`
- handler: `index.handler`
- runtime: `Node.js 20.x`

Example event:

```json
{
  "url": "https://store.epicgames.com/en-US/p/alan-wake-2",
  "mode": "browser"
}
```

Suggested environment variables:

- `PROXY_SHARED_SECRET`

If `PROXY_SHARED_SECRET` is set, the caller must send the same value in one of:

- request header `x-proxy-secret`
- JSON body field `secret`
- query string field `secret`

Response shape:

```json
{
  "ok": true,
  "mode": "browser",
  "inputUrl": "https://example.com",
  "finalUrl": "https://example.com",
  "status": 200,
  "blocked": false,
  "title": "Example",
  "headers": {
    "content-type": "text/html; charset=utf-8"
  },
  "html": "<!doctype html>..."
}
```

Notes:

- Keep parsing and price detection on the main server.
- Deploy this Lambda from the zip artifact built in this repo.
- Both `http` and `browser` modes use the same Lambda package.

## Zip build

Build a zip artifact from the repo root with:

```bash
npm run build:regional-proxy
```

That creates:

```text
lambda/regional-proxy/dist/regional-proxy.zip
```

Create the Lambda using:

- package type: `Zip`
- runtime: `Node.js 20.x`
- handler: `index.handler`
- code source: `lambda/regional-proxy/dist/regional-proxy.zip`

Suggested Lambda settings for browser mode:

- architecture: `x86_64`
- memory: `1536 MB` to start
- timeout: `60 seconds`

Suggested test event:

```json
{
  "url": "https://store.epicgames.com/en-US/p/alan-wake-2",
  "mode": "browser"
}
```

Expected good result:

- `status` is a real page response, not a challenge failure
- `blocked` is `false`
- `title` is the actual page title
- `html` contains the real page markup
