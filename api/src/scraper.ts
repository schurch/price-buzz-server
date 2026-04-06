import { config } from "./config.js";
import { utcNow } from "./utils.js";
import type { DetectionResult, ScrapeDebugResult, ScrapePreferences, TrackedItemRecord } from "./types.js";
import {
  detectBlockedPageMessage,
  hasEmbeddedPriceSignals,
  isBrowserChallengePage,
  shouldTryBrowserForHttpPage,
  shouldUseBrowserFallback,
  shouldUseBrowserFallbackForHtml
} from "./scraper/blocking.js";
import { detectTrackedItemFromHtml, extractTrackedItemCheckDataFromHtml } from "./scraper/detection.js";
import { AccessBlockedError, HttpStatusError } from "./scraper/errors.js";
import {
  inferPreferredRegion,
  resolveRegionalFallbackRegion,
  shouldPreferNzRegionalFallback,
  shouldRetryTrackedItemCheckWithRegional,
  shouldRetryWithNzRegionalFallback
} from "./scraper/policy.js";
import { validateScrapeUrl } from "./scraper/url.js";

export { detectTrackedItemFromHtml, detectAvailabilityFromHtml, extractTrackedItemCheckDataFromHtml } from "./scraper/detection.js";
export { resolveRegionalFallbackRegion, shouldRetryWithNzRegionalFallback } from "./scraper/policy.js";
export { validateScrapeUrl } from "./scraper/url.js";

type FetchMode = "http" | "browser" | "regional-http" | "regional-browser";

function parseHeaders(headersJson: string | null): Record<string, string> {
  if (!headersJson) {
    return {};
  }

  try {
    const parsed = JSON.parse(headersJson) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function defaultReferer(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.host}/`;
  } catch {
    return null;
  }
}

function buildScrapeHeaders(
  headers: Record<string, string>,
  scrapePreferences: ScrapePreferences | null
): Record<string, string> {
  const requestHeaders: Record<string, string> = {
    "User-Agent": config.userAgent,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    ...headers
  };
  if (scrapePreferences?.acceptLanguage?.trim()) {
    requestHeaders["Accept-Language"] = scrapePreferences.acceptLanguage.trim();
  }

  return requestHeaders;
}

async function fetchHtmlWithHttp(
  rawUrl: string,
  headers: Record<string, string>,
  scrapePreferences: ScrapePreferences | null
): Promise<{ html: string; url: string }> {
  let currentUrl = (await validateScrapeUrl(rawUrl)).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutSeconds * 1000);

  try {
    for (let redirects = 0; redirects < 5; redirects += 1) {
      const response = await fetch(currentUrl, {
        headers: buildScrapeHeaders(headers, scrapePreferences),
        signal: controller.signal,
        redirect: "manual"
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          throw new Error("Redirect response did not include a location.");
        }
        currentUrl = (await validateScrapeUrl(new URL(location, currentUrl).toString())).toString();
        continue;
      }

      if (!response.ok) {
        const responseText = await response.text();
        throw new HttpStatusError(
          `Request failed with ${response.status} ${response.statusText}`,
          response.status,
          response.headers,
          responseText
        );
      }

      return {
        html: await response.text(),
        url: response.url
      };
    }

    throw new Error("Too many redirects while fetching this URL.");
  } finally {
    clearTimeout(timeout);
  }
}

function escapeInlineScriptJson(input: string): string {
  return input.replace(/<\/script/gi, "<\\/script");
}

function appendCapturedJsonPayloads(html: string, payloads: string[]): string {
  if (payloads.length === 0) {
    return html;
  }

  const scripts = payloads.map((payload, index) =>
    `<script type="application/json" data-pricebuzz-capture="${index}">${escapeInlineScriptJson(payload)}</script>`
  ).join("");
  return `${html}\n${scripts}`;
}

function looksLikeRelevantJsonPayload(url: string, contentType: string, body: string): boolean {
  if (body.length === 0) {
    return false;
  }

  if (!/json|graphql/i.test(contentType) && !/api|graphql|product|products|price/i.test(url)) {
    return false;
  }

  return /"price"|priceCurrency|salePrice|wasPrice|currentPrice|offerPrice|unitPrice|stockcode|sku|product/i.test(body);
}

function isRetryableBrowserError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ERR_HTTP2_PROTOCOL_ERROR|ERR_ABORTED|ERR_NETWORK_CHANGED|ERR_TIMED_OUT|Timeout/i.test(message);
}

async function navigateBrowserPage(page: any, rawUrl: string, timeoutMs: number): Promise<void> {
  const attempts: Array<{ waitUntil: "commit" | "domcontentloaded" | "load"; timeout: number }> = [
    { waitUntil: "commit", timeout: Math.max(8_000, Math.floor(timeoutMs * 0.6)) },
    { waitUntil: "domcontentloaded", timeout: timeoutMs },
    { waitUntil: "load", timeout: Math.max(12_000, Math.floor(timeoutMs * 1.5)) }
  ];

  let lastError: unknown = null;
  for (const [index, attempt] of attempts.entries()) {
    try {
      await page.goto(rawUrl, attempt);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableBrowserError(error) || index === attempts.length - 1) {
        throw error;
      }
      await page.waitForTimeout(600 * (index + 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function settleBrowserPage(page: any, rawUrl: string, timeoutMs: number): Promise<string> {
  await page.waitForLoadState("domcontentloaded", { timeout: Math.max(4_000, Math.floor(timeoutMs * 0.5)) }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: Math.max(4_000, Math.floor(timeoutMs * 0.75)) }).catch(() => undefined);
  await page.waitForTimeout(750);

  let html = await page.content();
  const title = await page.title().catch(() => "");
  const blockedMessage = detectBlockedPageMessage(html, page.url(), title);
  if (blockedMessage) {
    throw new AccessBlockedError(blockedMessage);
  }
  if (isBrowserChallengePage(html, page.url(), title)) {
    await page.waitForTimeout(2_500);
    html = await page.content();
    const delayedBlockedMessage = detectBlockedPageMessage(html, page.url(), title);
    if (delayedBlockedMessage) {
      throw new AccessBlockedError(delayedBlockedMessage);
    }
  }

  if (shouldUseBrowserFallbackForHtml(rawUrl, html, page.url()) && !hasEmbeddedPriceSignals(html)) {
    await page.waitForTimeout(1_500);
    await page.reload({ waitUntil: "commit", timeout: Math.max(8_000, Math.floor(timeoutMs * 0.75)) }).catch(() => undefined);
    await page.waitForLoadState("domcontentloaded", { timeout: Math.max(4_000, Math.floor(timeoutMs * 0.5)) }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: Math.max(4_000, Math.floor(timeoutMs * 0.75)) }).catch(() => undefined);
    html = await page.content();
  }

  return html;
}

async function fetchHtmlWithBrowser(
  rawUrl: string,
  headers: Record<string, string>,
  scrapePreferences: ScrapePreferences | null
): Promise<{ html: string; url: string }> {
  const validatedUrl = await validateScrapeUrl(rawUrl);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });

  try {
    const context = await browser.newContext({
      userAgent: config.userAgent,
      viewport: { width: 1366, height: 900 },
      screen: { width: 1366, height: 900 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      colorScheme: "light",
      reducedMotion: "no-preference",
      ...(scrapePreferences?.browserLocale?.trim() ? { locale: scrapePreferences.browserLocale.trim() } : {}),
      ...(scrapePreferences?.browserTimezone?.trim() ? { timezoneId: scrapePreferences.browserTimezone.trim() } : {})
    });

    const capturedJsonPayloads: string[] = [];
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (!request.isNavigationRequest() && request.resourceType() !== "document") {
        await route.continue();
        return;
      }

      try {
        await validateScrapeUrl(request.url());
        await route.continue();
      } catch {
        await route.abort();
      }
    });

    const page = await context.newPage();
    page.on("response", (response) => {
      if (capturedJsonPayloads.length >= 8) {
        return;
      }

      void (async () => {
        try {
          const request = response.request();
          if (!["xhr", "fetch"].includes(request.resourceType())) {
            return;
          }

          const responseUrl = response.url();
          const originMatches = new URL(responseUrl).origin === new URL(rawUrl).origin;
          if (!originMatches) {
            return;
          }

          const contentType = response.headers()["content-type"] ?? "";
          const body = await response.text();
          if (!looksLikeRelevantJsonPayload(responseUrl, contentType, body)) {
            return;
          }

          capturedJsonPayloads.push(body.slice(0, 50_000));
        } catch {
          // Ignore response inspection failures and keep scraping.
        }
      })();
    });

    await page.setExtraHTTPHeaders({
      ...buildScrapeHeaders(headers, scrapePreferences),
      "Upgrade-Insecure-Requests": "1",
      "Sec-CH-UA": "\"Chromium\";v=\"134\", \"Not:A-Brand\";v=\"24\", \"Google Chrome\";v=\"134\"",
      "Sec-CH-UA-Mobile": "?0",
      "Sec-CH-UA-Platform": "\"Windows\""
    });
    await navigateBrowserPage(page, validatedUrl.toString(), config.timeoutSeconds * 1000);
    const html = await settleBrowserPage(page, rawUrl, config.timeoutSeconds * 1000);

    return {
      html: appendCapturedJsonPayloads(html, capturedJsonPayloads),
      url: page.url()
    };
  } finally {
    await browser.close();
  }
}

function pushScrapeDebugEvent(
  events: Array<{ step: string; detail: string }>,
  step: string,
  detail: string
): void {
  events.push({ step, detail });
}

type ScrapeObserver = (step: string, detail: string) => void;

type ResolvedPage = {
  html: string;
  url: string;
  fetchMode: FetchMode;
};

type ResolvedFetch = {
  page: ResolvedPage;
  requestHeaders: Record<string, string>;
  browserFallbackSuggested: boolean | null;
};

function noopScrapeObserver(): void {
  // Intentionally empty.
}

function buildRequestHeaders(
  rawUrl: string,
  headersJson: string | null,
  scrapePreferences: ScrapePreferences | null
): Record<string, string> {
  const headers = parseHeaders(headersJson);
  if (!headers.Referer) {
    const referer = defaultReferer(rawUrl);
    if (referer) {
      headers.Referer = referer;
    }
  }

  return headers;
}

export async function fetchHtmlViaRegionalProxy(
  rawUrl: string,
  region: "nz",
  mode: "http" | "browser"
): Promise<{
  html: string;
  url: string;
  fetchMode: FetchMode;
}> {
  const proxy = config.regionalProxy[region];
  if (!proxy?.url) {
    throw new Error(`Regional proxy not configured for ${region}`);
  }
  if (!proxy.secret) {
    throw new Error(`Regional proxy secret not configured for ${region}`);
  }
  await validateScrapeUrl(rawUrl);

  const response = await fetch(proxy.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-proxy-secret": proxy.secret
    },
    body: JSON.stringify({
      url: rawUrl,
      mode
    })
  });

  if (!response.ok) {
    throw new Error(`Regional proxy request failed with status ${response.status}`);
  }

  const payload = await response.json() as {
    ok?: boolean;
    status?: number | null;
    finalUrl?: string | null;
    html?: string | null;
    blocked?: boolean;
    error?: string | null;
  };

  if (!payload.html || !payload.finalUrl) {
    throw new Error(payload.error || `Regional proxy returned no HTML for ${rawUrl}`);
  }
  await validateScrapeUrl(payload.finalUrl);

  const title = /<title[^>]*>(.*?)<\/title>/i.exec(payload.html)?.[1]?.trim() ?? "";
  const blockedMessage = detectBlockedPageMessage(payload.html, payload.finalUrl, title);
  if (blockedMessage) {
    throw new AccessBlockedError(blockedMessage);
  }

  return {
    html: payload.html,
    url: payload.finalUrl,
    fetchMode: mode === "browser" ? "regional-browser" : "regional-http"
  };
}

async function fetchHtmlWithRegionalFallback(
  rawUrl: string,
  scrapePreferences: ScrapePreferences | null,
  expectedCurrency: string | null | undefined = null
): Promise<{
  html: string;
  url: string;
  fetchMode: FetchMode;
}> {
  const preferredRegion = resolveRegionalFallbackRegion(scrapePreferences, expectedCurrency);
  if (!preferredRegion) {
    throw new Error("No regional fallback configured for this request");
  }

  try {
    const httpPage = await fetchHtmlViaRegionalProxy(rawUrl, preferredRegion, "http");
    const needsBrowserRetry = (() => {
      if (preferredRegion !== "nz") {
        return false;
      }

      try {
        const detection = detectTrackedItemFromHtml(httpPage.url, httpPage.html);
        return detection.currency !== "NZD";
      } catch {
        return true;
      }
    })();

    if (!needsBrowserRetry) {
      return httpPage;
    }

    try {
      return await fetchHtmlViaRegionalProxy(rawUrl, preferredRegion, "browser");
    } catch {
      return httpPage;
    }
  } catch {
    return fetchHtmlViaRegionalProxy(rawUrl, preferredRegion, "browser");
  }
}

async function fetchHtmlWithPreferences(
  rawUrl: string,
  headersJson: string | null,
  scrapePreferences: ScrapePreferences | null,
  observer: ScrapeObserver = noopScrapeObserver
): Promise<ResolvedFetch> {
  const headers = buildRequestHeaders(rawUrl, headersJson, scrapePreferences);
  const tryRegionalFallback = async (
    expectedCurrency: string | null | undefined,
    reason: string
  ): Promise<ResolvedPage | null> => {
    if (!resolveRegionalFallbackRegion(scrapePreferences, expectedCurrency)) {
      return null;
    }

    try {
      observer("regional-fetch", `Attempting regional fallback because ${reason}.`);
      const page = await fetchHtmlWithRegionalFallback(rawUrl, scrapePreferences, expectedCurrency);
      observer("regional-fetch", `Regional fetch succeeded with final URL ${page.url}.`);
      return page;
    } catch (regionalError) {
      observer(
        "regional-fetch",
        `Regional fallback failed: ${regionalError instanceof Error ? regionalError.message : String(regionalError)}`
      );
      return null;
    }
  };

  try {
    observer("http-fetch", "Attempting standard HTTP fetch.");
    const page = await fetchHtmlWithHttp(rawUrl, headers, scrapePreferences);
    observer("http-fetch", `HTTP fetch succeeded with final URL ${page.url}.`);
    const { shouldTry, blockedMessage } = shouldTryBrowserForHttpPage(rawUrl, page);
    observer(
      "http-evaluation",
      shouldTry
        ? `Browser fallback suggested${blockedMessage ? ` because: ${blockedMessage}` : " due to page heuristics"}.`
        : "HTTP result looked usable without browser fallback."
    );
    if (shouldTry) {
      try {
        observer("browser-fetch", "Attempting browser fetch after HTTP evaluation.");
        const browserPage = await fetchHtmlWithBrowser(rawUrl, headers, scrapePreferences);
        observer("browser-fetch", `Browser fetch succeeded with final URL ${browserPage.url}.`);
        return {
          page: { ...browserPage, fetchMode: "browser" },
          requestHeaders: headers,
          browserFallbackSuggested: shouldTry
        };
      } catch (browserError) {
        observer(
          "browser-fetch",
          `Browser fetch failed: ${browserError instanceof Error ? browserError.message : String(browserError)}`
        );
        if (browserError instanceof AccessBlockedError) {
          const regionalPage = await tryRegionalFallback(null, "browser fetch was blocked after HTTP evaluation");
          if (regionalPage) {
            return {
              page: regionalPage,
              requestHeaders: headers,
              browserFallbackSuggested: true
            };
          }
          throw browserError;
        }
        if (blockedMessage) {
          const regionalPage = await tryRegionalFallback(null, "browser fetch failed after HTTP evaluation");
          if (regionalPage) {
            return {
              page: regionalPage,
              requestHeaders: headers,
              browserFallbackSuggested: true
            };
          }
          throw new AccessBlockedError(blockedMessage);
        }
        throw browserError;
      }
    }
    return {
      page: { ...page, fetchMode: "http" },
      requestHeaders: headers,
      browserFallbackSuggested: shouldTry
    };
  } catch (error) {
    if (error instanceof AccessBlockedError) {
      const regionalPage = await tryRegionalFallback(null, "local scraping was blocked");
      if (regionalPage) {
        return {
          page: regionalPage,
          requestHeaders: headers,
          browserFallbackSuggested: true
        };
      }
      throw error;
    }
    if (shouldUseBrowserFallback(error)) {
      observer(
        "http-fetch",
        `HTTP fetch failed with browser-fallback-eligible error: ${error instanceof Error ? error.message : String(error)}`
      );
      try {
        observer("browser-fetch", "Attempting browser fetch after HTTP failure.");
        const page = await fetchHtmlWithBrowser(rawUrl, headers, scrapePreferences);
        observer("browser-fetch", `Browser fetch succeeded with final URL ${page.url}.`);
        return {
          page: { ...page, fetchMode: "browser" },
          requestHeaders: headers,
          browserFallbackSuggested: true
        };
      } catch (browserError) {
        observer(
          "browser-fetch",
          `Browser fetch failed: ${browserError instanceof Error ? browserError.message : String(browserError)}`
        );
        const regionalPage = await tryRegionalFallback(null, "browser fetch failed after HTTP transport error");
        if (regionalPage) {
          return {
            page: regionalPage,
            requestHeaders: headers,
            browserFallbackSuggested: true
          };
        }
        throw browserError;
      }
    }
    observer(
      "http-fetch",
      `Scrape failed before a usable page was returned: ${error instanceof Error ? error.message : String(error)}`
    );
    const regionalPage = await tryRegionalFallback(null, "local scraping failed");
    if (regionalPage) {
      return {
        page: regionalPage,
        requestHeaders: headers,
        browserFallbackSuggested: shouldUseBrowserFallback(error)
      };
    }
    throw error;
  }
}

async function resolveDetectedPage(
  rawUrl: string,
  scrapePreferences: ScrapePreferences | null,
  observer: ScrapeObserver = noopScrapeObserver
): Promise<ResolvedFetch & { detection: DetectionResult }> {
  let resolved = await fetchHtmlWithPreferences(rawUrl, null, scrapePreferences, observer);
  let detection = detectTrackedItemFromHtml(resolved.page.url, resolved.page.html);

  if (
    (resolved.page.fetchMode === "http" || resolved.page.fetchMode === "browser")
    && shouldPreferNzRegionalFallback(scrapePreferences, detection)
  ) {
    try {
      observer(
        "regional-fetch",
        `Attempting regional fallback because local ${resolved.page.fetchMode} fetch detected ${detection.currency || "no currency"} instead of NZD.`
      );
      const regionalPage = await fetchHtmlWithRegionalFallback(rawUrl, scrapePreferences, detection.currency);
      observer("regional-fetch", `Regional fetch succeeded with final URL ${regionalPage.url}.`);
      const regionalDetection = detectTrackedItemFromHtml(regionalPage.url, regionalPage.html);
      if (regionalDetection.currency === "NZD") {
        resolved = {
          ...resolved,
          page: regionalPage
        };
        detection = regionalDetection;
      }
    } catch (error) {
      observer(
        "regional-fetch",
        `Regional fallback failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return {
    ...resolved,
    detection
  };
}

function buildScrapeDebugResult(
  inputUrl: string,
  page: { html: string; url: string; fetchMode: FetchMode },
  scrapePreferences: ScrapePreferences | null,
  requestHeaders: Record<string, string>,
  browserFallbackSuggested: boolean | null,
  events: Array<{ step: string; detail: string }>
): ScrapeDebugResult {
  const pageTitle = /<title[^>]*>(.*?)<\/title>/i.exec(page.html)?.[1]?.trim() || null;
  let detection: DetectionResult | null = null;
  try {
    detection = detectTrackedItemFromHtml(page.url, page.html);
  } catch {
    detection = null;
  }
  return {
    inputUrl,
    finalUrl: page.url,
    fetchMode: page.fetchMode,
    pageTitle,
    blockedMessage: detectBlockedPageMessage(page.html, page.url, pageTitle ?? ""),
    errorMessage: null,
    html: page.html,
    htmlBytes: Buffer.byteLength(page.html, "utf8"),
    scrapePreferences,
    inferredRegion: inferPreferredRegion(scrapePreferences),
    requestHeaders,
    browserFallbackSuggested,
    detection,
    events
  };
}

export async function fetchScrapeDebugResult(
  rawUrl: string,
  scrapePreferences: ScrapePreferences | null = null
): Promise<ScrapeDebugResult> {
  const headers = buildRequestHeaders(rawUrl, null, scrapePreferences);
  const events: Array<{ step: string; detail: string }> = [];
  pushScrapeDebugEvent(events, "start", `Input URL: ${rawUrl}`);
  pushScrapeDebugEvent(
    events,
    "localisation",
    `acceptLanguage=${scrapePreferences?.acceptLanguage ?? "n/a"}, locale=${scrapePreferences?.browserLocale ?? "n/a"}, timezone=${scrapePreferences?.browserTimezone ?? "n/a"}, inferredRegion=${inferPreferredRegion(scrapePreferences) ?? "n/a"}`
  );
  pushScrapeDebugEvent(
    events,
    "headers",
    `User-Agent=${headers["User-Agent"] ?? "n/a"}, Referer=${headers.Referer ?? "n/a"}, Accept-Language=${scrapePreferences?.acceptLanguage ?? "n/a"}`
  );

  try {
    const resolved = await resolveDetectedPage(
      rawUrl,
      scrapePreferences,
      (step, detail) => pushScrapeDebugEvent(events, step, detail)
    );
    return {
      ...buildScrapeDebugResult(
        rawUrl,
        resolved.page,
        scrapePreferences,
        resolved.requestHeaders,
        resolved.browserFallbackSuggested,
        events
      ),
      detection: resolved.detection
    };
  } catch (error) {
    return {
      inputUrl: rawUrl,
      finalUrl: null,
      fetchMode: null,
      pageTitle: null,
      blockedMessage: error instanceof AccessBlockedError ? error.message : null,
      errorMessage: error instanceof Error ? error.message : String(error),
      html: null,
      htmlBytes: null,
      scrapePreferences,
      inferredRegion: inferPreferredRegion(scrapePreferences),
      requestHeaders: headers,
      browserFallbackSuggested: shouldUseBrowserFallback(error),
      detection: null,
      events
    };
  }
}

export async function detectTrackedItem(rawUrl: string, scrapePreferences: ScrapePreferences | null = null): Promise<DetectionResult> {
  const resolved = await resolveDetectedPage(rawUrl, scrapePreferences);
  return resolved.detection;
}

export async function fetchTrackedItemCheck(
  item: TrackedItemRecord,
  scrapePreferences: ScrapePreferences | null = null
): Promise<{
  status: "ok" | "error";
  checkedAt: string;
  availability?: "available" | "unavailable" | null;
  price?: string | null;
  currency?: string | null;
  rawText?: string | null;
  errorMessage?: string | null;
}> {
  try {
    const resolved = await fetchHtmlWithPreferences(item.url, item.headersJson, scrapePreferences);
    let page = resolved.page;
    let { rawText, price, currency, availability } = extractTrackedItemCheckDataFromHtml(item, page.html);

    if (
      (page.fetchMode === "http" || page.fetchMode === "browser")
      && shouldRetryTrackedItemCheckWithRegional(
        scrapePreferences,
        item.initialDetectedCurrency || item.currency,
        currency
      )
    ) {
      try {
        const regionalPage = await fetchHtmlWithRegionalFallback(
          item.url,
          scrapePreferences,
          item.initialDetectedCurrency || item.currency
        );
        const regional = extractTrackedItemCheckDataFromHtml(item, regionalPage.html);
        const regionalRawText = regional.rawText;
        const regionalPrice = regional.price;
        const regionalCurrency = regional.currency;
        const regionalAvailability = regional.availability;

        if (
          regionalCurrency === "NZD"
          || (!currency && regionalCurrency)
        ) {
          page = regionalPage;
          rawText = regionalRawText;
          price = regionalPrice;
          currency = regionalCurrency;
          availability = regionalAvailability;
        }
      } catch {
        // Keep the local result if the regional fallback cannot improve it.
      }
    }

    return {
      status: "ok",
      checkedAt: utcNow(),
      availability: availability ?? null,
      price,
      currency: currency ?? item.currency,
      rawText
    };
  } catch (error) {
    return {
      status: "error",
      checkedAt: utcNow(),
      errorMessage: error instanceof Error ? error.message : String(error)
    };
  }
}
