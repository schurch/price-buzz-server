const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DEFAULT_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const DEFAULT_ACCEPT_LANGUAGE = "en-NZ,en;q=0.9";

export const handler = async (event) => {
  const request = parseProxyRequest(event);
  if (!request.ok) {
    return json(request.statusCode, { error: request.error });
  }

  if (!authorize(event)) {
    return json(401, { error: "Unauthorized" });
  }

  try {
    const response =
      request.mode === "browser"
        ? await fetchWithBrowser(request.url)
        : await fetchWithHttp(request.url);

    return json(200, response);
  } catch (error) {
    return json(500, {
      ok: false,
      mode: request.mode,
      inputUrl: request.url,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

export function parseProxyRequest(event) {
  const bodyPayload =
    typeof event?.body === "string" ? safeJson(event.body) : event?.body ?? null;
  const query = event?.queryStringParameters ?? null;

  const url =
    bodyPayload?.url ??
    query?.url ??
    event?.url ??
    null;
  const mode =
    bodyPayload?.mode ??
    query?.mode ??
    event?.mode ??
    "http";

  if (!url || typeof url !== "string") {
    return { ok: false, statusCode: 400, error: "Missing url" };
  }

  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { ok: false, statusCode: 400, error: "Invalid url protocol" };
    }
  } catch {
    return { ok: false, statusCode: 400, error: "Invalid url" };
  }

  if (mode !== "http" && mode !== "browser") {
    return { ok: false, statusCode: 400, error: "Invalid mode" };
  }

  return {
    ok: true,
    statusCode: 200,
    url,
    mode
  };
}

export function authorize(event) {
  const expected = process.env.PROXY_SHARED_SECRET?.trim();
  if (!expected) {
    return true;
  }

  const bodyPayload =
    typeof event?.body === "string" ? safeJson(event.body) : event?.body ?? null;
  const query = event?.queryStringParameters ?? null;
  const headerSecret = event?.headers?.["x-proxy-secret"] ?? event?.headers?.["X-Proxy-Secret"] ?? null;
  const provided =
    headerSecret ??
    bodyPayload?.secret ??
    query?.secret ??
    event?.secret ??
    null;

  return provided === expected;
}

export function looksBlocked(title, html) {
  const sample = `${title ?? ""}\n${(html ?? "").slice(0, 8000)}`.toLowerCase();
  return (
    sample.includes("just a moment") ||
    sample.includes("enable javascript and cookies to continue") ||
    sample.includes("captcha") ||
    sample.includes("access denied") ||
    sample.includes("temporarily unavailable") ||
    sample.includes("/cdn-cgi/challenge-platform/") ||
    sample.includes("cf-chl-") ||
    sample.includes("bot verification")
  );
}

export function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].trim() : null;
}

export function pickHeaders(headers, names) {
  const output = {};
  for (const name of names) {
    const value = headers.get(name);
    if (value) {
      output[name] = value;
    }
  }
  return output;
}

export async function fetchWithHttp(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": DEFAULT_USER_AGENT,
      accept: DEFAULT_ACCEPT,
      "accept-language": DEFAULT_ACCEPT_LANGUAGE,
      "cache-control": "no-cache",
      pragma: "no-cache"
    }
  });

  const html = await response.text();
  const title = extractTitle(html);

  return {
    ok: response.ok,
    mode: "http",
    inputUrl: url,
    finalUrl: response.url,
    status: response.status,
    blocked: looksBlocked(title, html),
    title,
    headers: pickHeaders(response.headers, [
      "content-type",
      "content-language",
      "server",
      "set-cookie",
      "location",
      "x-cache",
      "cf-ray",
      "cf-cache-status"
    ]),
    html
  };
}

export async function fetchWithBrowser(url) {
  const chromiumPackage = await import("@sparticuz/chromium");
  const playwrightPackage = await import("playwright-core");
  const chromium = chromiumPackage.default;
  const playwright = playwrightPackage.chromium;

  let browser;
  try {
    browser = await playwright.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless
    });

    const page = await browser.newPage({
      userAgent: DEFAULT_USER_AGENT,
      locale: "en-NZ"
    });

    await page.setExtraHTTPHeaders({
      accept: DEFAULT_ACCEPT,
      "accept-language": DEFAULT_ACCEPT_LANGUAGE,
      "cache-control": "no-cache",
      pragma: "no-cache"
    });

    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 45000
    });

    await page.waitForTimeout(5000);

    const html = await page.content();
    const title = await page.title();
    const finalUrl = page.url();
    const responseHeaders = response ? response.headers() : {};

    return {
      ok: response ? response.ok() : true,
      mode: "browser",
      inputUrl: url,
      finalUrl,
      status: response ? response.status() : null,
      blocked: looksBlocked(title, html),
      title,
      headers: pickPlaywrightHeaders(responseHeaders, [
        "content-type",
        "content-language",
        "server",
        "set-cookie",
        "location",
        "x-cache",
        "cf-ray",
        "cf-cache-status"
      ]),
      html
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

function pickPlaywrightHeaders(headers, names) {
  const output = {};
  for (const name of names) {
    const value = headers?.[name];
    if (value) {
      output[name] = value;
    }
  }
  return output;
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body, null, 2)
  };
}
