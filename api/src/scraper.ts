import * as cheerio from "cheerio";
import dns from "node:dns/promises";
import net from "node:net";
import { config } from "./config.js";
import { utcNow } from "./utils.js";
import type { DetectionResult, ScrapeDebugResult, ScrapePreferences, TrackedItemRecord } from "./types.js";

type FetchMode = "http" | "browser" | "regional-http" | "regional-browser";

const COMMON_PRICE_SELECTORS = [
  "meta[property='product:price:amount']",
  "meta[itemprop='price']",
  "[itemprop='price']",
  "[data-testid*='price']",
  "[data-component*='Price']",
  "[aria-label*='price' i]",
  ".product__price",
  ".product-price",
  ".price",
  "[data-price]",
  "[class*='price']"
];

class HttpStatusError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly headers: Headers,
    readonly responseText: string
  ) {
    super(message);
    this.name = "HttpStatusError";
  }
}

class AccessBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessBlockedError";
  }
}

function isBlockedIpAddress(ip: string): boolean {
  if (net.isIP(ip) === 4) {
    if (ip === "127.0.0.1" || ip === "0.0.0.0") return true;
    if (ip.startsWith("10.")) return true;
    if (ip.startsWith("192.168.")) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
    if (ip.startsWith("169.254.")) return true;
    if (ip === "100.100.100.200") return true;
    return false;
  }

  if (net.isIP(ip) === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === "::1" || normalized === "::") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    if (normalized.startsWith("fe80:")) return true;
    if (normalized.startsWith("::ffff:127.")) return true;
    if (normalized.startsWith("::ffff:10.")) return true;
    if (normalized.startsWith("::ffff:192.168.")) return true;
    if (/^::ffff:172\.(1[6-9]|2\d|3[0-1])\./.test(normalized)) return true;
    if (normalized.startsWith("::ffff:169.254.")) return true;
    return false;
  }

  return true;
}

export async function validateScrapeUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http and https URLs are allowed.");
  }

  const hostname = parsed.hostname.trim().toLowerCase();
  if (!hostname) {
    throw new Error("Invalid URL hostname.");
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Private or local network targets are not allowed.");
  }

  if (net.isIP(hostname)) {
    if (isBlockedIpAddress(hostname)) {
      throw new Error("Private or local network targets are not allowed.");
    }
    return parsed;
  }

  const records = await dns.lookup(hostname, { all: true });
  if (records.length === 0 || records.some((record) => isBlockedIpAddress(record.address))) {
    throw new Error("Private or local network targets are not allowed.");
  }

  return parsed;
}

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

const ISO_CURRENCY_CODES = new Set([
  "AUD",
  "CAD",
  "CHF",
  "EUR",
  "GBP",
  "HKD",
  "JPY",
  "NZD",
  "SGD",
  "USD"
]);

function isSupportedCurrencyCode(value: string | null | undefined): value is string {
  return Boolean(value && ISO_CURRENCY_CODES.has(value.toUpperCase()));
}

function defaultReferer(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.host}/`;
  } catch {
    return null;
  }
}

function extractBestNumericToken(source: string): string | null {
  const normalized = source
    .replaceAll(",", "")
    .replace(/\s*\.\s*/g, ".")
    .replace(/\s+/g, " ");

  const preferredPatterns = [
    /(?:NZ\$|A\$|AU\$|US\$|\$|€|£)\s*([0-9]+(?:\.[0-9]{2})?)/i,
    /([0-9]+(?:\.[0-9]{2})?)\s*(?:[A-Z]{3})\b/i,
    /(?:[A-Z]{3})\s*([0-9]+(?:\.[0-9]{2})?)/i,
    /price[^\d]{0,12}([0-9]+(?:\.[0-9]{2})?)/i,
    /sale[^\d]{0,12}([0-9]+(?:\.[0-9]{2})?)/i,
    /now[^\d]{0,12}([0-9]+(?:\.[0-9]{2})?)/i
  ];

  for (const pattern of preferredPatterns) {
    const match = pattern.exec(normalized);
    if (match?.[1]) {
      return match[1];
    }
  }

  const allMatches = Array.from(normalized.matchAll(/-?\d+(?:\.\d+)?/g)).map((match) => match[0]);
  if (allMatches.length === 0) {
    return null;
  }

  const decimalMatch = allMatches.find((match) => match.includes("."));
  if (decimalMatch) {
    return decimalMatch;
  }

  return allMatches[0] ?? null;
}

function normalizePrice(priceText: string, regex: string | null): string {
  let source = priceText;
  if (regex) {
    const match = new RegExp(regex).exec(source);
    if (!match) {
      throw new Error(`Regex did not match extracted text: ${regex}`);
    }
    source = match[1] ?? match[0];
  }

  const normalized = source
    .replaceAll(",", "")
    .replace(/\s*\.\s*/g, ".")
    .replace(/\s+/g, " ");
  const token = extractBestNumericToken(normalized);
  if (!token) {
    throw new Error(`Could not parse numeric price from: ${priceText}`);
  }

  return Number.parseFloat(token).toFixed(2);
}

function buildPriceExtraction(rawText: string): { previewPrice: string; regex: string | null } {
  const compact = rawText.replace(/\s+/g, " ").trim();
  const numberPattern = "([0-9]+(?:\\s*\\.\\s*[0-9]{2})?)";

  const inclusivePatterns = [
    new RegExp(`${numberPattern}\\s*(?:inc|incl)\\.?\\s*gst\\b`, "i"),
    new RegExp(`(?:inc|incl)\\.?\\s*gst\\b[\\s:]*\\$?\\s*${numberPattern}`, "i"),
    new RegExp(`${numberPattern}\\s*(?:inc|incl)\\.?\\s*vat\\b`, "i"),
    new RegExp(`(?:inc|incl)\\.?\\s*vat\\b[\\s:]*\\$?\\s*${numberPattern}`, "i"),
    new RegExp(`${numberPattern}\\s*(?:inc|incl)\\.?\\s*tax\\b`, "i"),
    new RegExp(`(?:inc|incl)\\.?\\s*tax\\b[\\s:]*\\$?\\s*${numberPattern}`, "i"),
    new RegExp(`${numberPattern}\\s*(?:including|with)\\s+tax\\b`, "i"),
    new RegExp(`(?:including|with)\\s+tax\\b[\\s:]*\\$?\\s*${numberPattern}`, "i"),
    new RegExp(`${numberPattern}\\s*tax\\s*included\\b`, "i"),
    new RegExp(`tax\\s*included\\b[\\s:]*\\$?\\s*${numberPattern}`, "i"),
    new RegExp(`${numberPattern}\\s*tva\\s*incl(?:use)?\\b`, "i"),
    new RegExp(`${numberPattern}\\s*ttc\\b`, "i")
  ];
  for (const pattern of inclusivePatterns) {
    const match = pattern.exec(compact);
    if (match?.[1]) {
      return {
        previewPrice: normalizePrice(match[1], null),
        regex: pattern.source
      };
    }
  }

  return {
    previewPrice: normalizePrice(rawText, null),
    regex: null
  };
}

function isPlausiblePriceText(rawText: string): boolean {
  const compact = rawText.replace(/\s+/g, " ").trim();
  const normalized = compact.replaceAll(",", "");
  const explicitCurrency = /NZ\$|A\$|AU\$|US\$|\b[A-Z]{3}\b|€|£/i.test(compact);
  const bareDollar = /^\$\s*/.test(compact);
  const numericParts = normalized.match(/\d+/g) ?? [];
  if (numericParts.length === 0) {
    return false;
  }

  const longestDigitRun = numericParts.reduce((longest, part) => Math.max(longest, part.length), 0);
  if ((explicitCurrency || bareDollar) && !/\.\d{2}\b/.test(normalized) && longestDigitRun >= 6) {
    return false;
  }

  if ((explicitCurrency || bareDollar) && /^\$\s*0\d{4,}\b/.test(normalized)) {
    return false;
  }

  return true;
}

function extractCurrencyCode(source: string): string {
  const compact = source.replace(/\s+/g, " ").trim();
  const priceCurrencyMatch = /(?:pricecurrency|currency)["']?\s*[:=]\s*["']([A-Z]{3})["']/i.exec(compact);
  if (isSupportedCurrencyCode(priceCurrencyMatch?.[1])) {
    return priceCurrencyMatch[1].toUpperCase();
  }

  const leadingCodeMatch = /\b([A-Z]{3})\s*[0-9]+(?:\.[0-9]{2})?\b/.exec(compact);
  if (isSupportedCurrencyCode(leadingCodeMatch?.[1])) {
    return leadingCodeMatch[1].toUpperCase();
  }

  const trailingCodeMatch = /\b[0-9]+(?:\.[0-9]{2})?\s*([A-Z]{3})\b/.exec(compact);
  if (isSupportedCurrencyCode(trailingCodeMatch?.[1])) {
    return trailingCodeMatch[1].toUpperCase();
  }

  if (/NZ\$|NZD/i.test(compact)) return "NZD";
  if (/A\$|AU\$|AUD/i.test(compact)) return "AUD";
  if (/US\$|USD/i.test(compact)) return "USD";
  if (/C\$|CAD/i.test(compact)) return "CAD";
  if (/S\$|SGD/i.test(compact)) return "SGD";
  if (/HK\$|HKD/i.test(compact)) return "HKD";
  if (/¥|JPY/i.test(compact)) return "JPY";
  if (/CHF/i.test(compact)) return "CHF";
  if (/€|EUR/i.test(compact)) return "EUR";
  if (/£|GBP/i.test(compact)) return "GBP";

  return "";
}

function hasExplicitCurrencyMarker(source: string): boolean {
  return /NZ\$|A\$|AU\$|US\$|C\$|S\$|HK\$|\b(?:AUD|CAD|CHF|EUR|GBP|HKD|JPY|NZD|SGD|USD)\b|€|£|¥/i.test(source);
}

function readCandidateRawText(node: cheerio.Cheerio<any>): {
  raw: string;
  attribute: string | null;
} {
  if (node.is("meta")) {
    return {
      raw: (node.attr("content") ?? "").trim(),
      attribute: "content"
    };
  }

  if (node.attr("data-price")) {
    return {
      raw: (node.attr("data-price") ?? "").trim(),
      attribute: "data-price"
    };
  }

  return {
    raw: node.text().trim(),
    attribute: null
  };
}

export function extractTrackedItemCheckDataFromHtml(
  item: TrackedItemRecord,
  html: string
): {
  rawText: string;
  price: string;
  currency: string | null;
} {
  const detection = detectTrackedItemFromHtml(item.url, html);
  return {
    rawText: detection.previewRawText,
    price: detection.previewPrice,
    currency: detection.currency || item.currency || null
  };
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

function countShellSignals(rawUrl: string, html: string, finalUrl: string): number {
  let signals = 0;
  const loweredHtml = html.toLowerCase();
  const titleMatch = /<title[^>]*>(.*?)<\/title>/i.exec(html);
  const titleText = (titleMatch?.[1] ?? "").trim();
  if (!titleText) {
    signals += 2;
  }

  if (/<base\s+href=["']\/["']/i.test(html)) {
    signals += 1;
  }

  if (/id=["'](__next|root|app-root|app)["']/i.test(html) || /<app-root\b/i.test(html)) {
    signals += 1;
  }

  if (/ng-version=|__next|window\.__initial_state__|window\.__apollo_state__/i.test(html)) {
    signals += 1;
  }

  const canonicalMatch = /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i.exec(html);
  if (canonicalMatch?.[1]) {
    try {
      const requested = new URL(rawUrl);
      const canonical = new URL(canonicalMatch[1], finalUrl);
      if (canonical.origin === requested.origin && canonical.pathname === "/" && requested.pathname !== "/") {
        signals += 2;
      }
    } catch {
      // Ignore malformed URLs in markup.
    }
  }

  const ogUrlMatch = /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i.exec(html);
  if (ogUrlMatch?.[1]) {
    try {
      const requested = new URL(rawUrl);
      const ogUrl = new URL(ogUrlMatch[1], finalUrl);
      if (ogUrl.origin === requested.origin && ogUrl.pathname === "/" && requested.pathname !== "/") {
        signals += 2;
      }
    } catch {
      // Ignore malformed URLs in markup.
    }
  }

  if (!/price|product:price|pricecurrency|itemprop=["']price["']|data-price|schema\.org\/product/i.test(loweredHtml)) {
    signals += 1;
  }

  return signals;
}

function shouldUseBrowserFallbackForHtml(rawUrl: string, html: string, finalUrl: string): boolean {
  if (/product:price|pricecurrency|itemprop=["']price["']|data-price|schema\.org\/product/i.test(html)) {
    return false;
  }

  return countShellSignals(rawUrl, html, finalUrl) >= 4;
}

function shouldUseBrowserFallback(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /fetch failed|http\/2|http2|protocol error|internal_error|socket hang up|econnreset|ec on? reset|terminated|other side closed|connection closed|reset/i.test(message)
  ) {
    return true;
  }

  if (!(error instanceof HttpStatusError)) {
    return false;
  }

  if (error.status === 403) {
    return true;
  }

  const cfMitigated = error.headers.get("cf-mitigated");
  if (cfMitigated && cfMitigated.toLowerCase() === "challenge") {
    return true;
  }

  return /cloudflare|challenge|attention required/i.test(error.responseText);
}

function detectBlockedPageMessage(html: string, pageUrl: string, title: string): string | null {
  const lowered = `${title}\n${pageUrl}\n${html.slice(0, 16000)}`.toLowerCase();

  if (/\/waf_deny_page\/|temporarily down|error code:\s*#\d+|access denied/.test(lowered)) {
    return "This retailer is blocking automated access right now, so PriceBuzz could not load the real product page.";
  }

  if (/captcha|verify you are human|unusual traffic|bot detection|just a moment|enable javascript|enable cookies/.test(lowered)) {
    return "This retailer is challenging automated traffic right now, so PriceBuzz could not load the real product page.";
  }

  return null;
}

function inferPreferredRegion(scrapePreferences: ScrapePreferences | null): "nz" | null {
  if (!scrapePreferences) {
    return null;
  }

  const acceptLanguage = scrapePreferences.acceptLanguage?.toLowerCase() ?? "";
  const browserLocale = scrapePreferences.browserLocale?.toLowerCase() ?? "";
  const browserTimezone = scrapePreferences.browserTimezone?.toLowerCase() ?? "";
  const combined = `${acceptLanguage} ${browserLocale}`;

  if (browserTimezone === "pacific/auckland") {
    return "nz";
  }
  if (/(^|[^a-z])nz([^a-z]|$)/.test(combined) || /\b(?:en|mi)-nz\b/.test(combined)) {
    return "nz";
  }

  return null;
}

function shouldPreferNzRegionalFallback(
  scrapePreferences: ScrapePreferences | null,
  detection: DetectionResult
): boolean {
  return shouldRetryWithNzRegionalFallback(scrapePreferences, detection.currency, detection.currency);
}

export function resolveRegionalFallbackRegion(
  scrapePreferences: ScrapePreferences | null,
  expectedCurrency: string | null | undefined
): "nz" | null {
  const prefersNz = inferPreferredRegion(scrapePreferences) === "nz";
  const expectsNz = (expectedCurrency ?? "").toUpperCase() === "NZD";

  if (!prefersNz && !expectsNz) {
    return null;
  }

  return "nz";
}

function shouldRetryTrackedItemCheckWithRegional(
  scrapePreferences: ScrapePreferences | null,
  expectedCurrency: string | null | undefined,
  currency: string | null | undefined
): boolean {
  return shouldRetryWithNzRegionalFallback(scrapePreferences, expectedCurrency, currency);
}

export function shouldRetryWithNzRegionalFallback(
  scrapePreferences: ScrapePreferences | null,
  expectedCurrency: string | null | undefined,
  localCurrency: string | null | undefined
): boolean {
  const region = resolveRegionalFallbackRegion(scrapePreferences, expectedCurrency);
  if (region !== "nz") {
    return false;
  }

  return !localCurrency || localCurrency !== "NZD";
}

function isBrowserChallengePage(html: string, pageUrl: string, title: string): boolean {
  const lowered = `${title}\n${pageUrl}\n${html.slice(0, 12000)}`.toLowerCase();
  return /captcha|verify you are human|access denied|temporarily blocked|unusual traffic|enable javascript|enable cookies|akamai|bot detection|just a moment/.test(lowered);
}

function hasEmbeddedPriceSignals(html: string): boolean {
  return /product:price|pricecurrency|itemprop=["']price["']|data-price|schema\.org\/product|"price"\s*:|price__dollars|price__cents/i.test(html);
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
    await page.setExtraHTTPHeaders(buildScrapeHeaders(headers, scrapePreferences));
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

function detectCurrency(html: string, $: cheerio.CheerioAPI): string {
  const metaCurrency = $("meta[property='product:price:currency']").attr("content")
    || $("meta[itemprop='priceCurrency']").attr("content");
  if (isSupportedCurrencyCode(metaCurrency)) {
    return metaCurrency.trim().toUpperCase();
  }

  const jsonCurrencyMatch = /"priceCurrency"\s*:\s*"([A-Z]{3})"/i.exec(html)
    || /"currency"\s*:\s*"([A-Z]{3})"/i.exec(html);
  if (isSupportedCurrencyCode(jsonCurrencyMatch?.[1])) {
    return jsonCurrencyMatch[1].toUpperCase();
  }

  return extractCurrencyCode(html);
}

function inferCurrencyFromText(value: string): string {
  return extractCurrencyCode(value);
}

function scoreInlineCurrencyMatch(pageHtml: string, startIndex: number, rawText: string): number {
  const context = pageHtml.slice(Math.max(0, startIndex - 240), Math.min(pageHtml.length, startIndex + 240)).toLowerCase();
  let score = 0;

  if (/nz\$|nzd|a\$|au\$|aud|us\$|usd|c\$|cad|s\$|sgd|hk\$|hkd|¥|jpy|chf|€|eur|£|gbp/i.test(rawText)) {
    score += 8;
  } else if (/^\s*\$\s*/.test(rawText)) {
    score -= 6;
  }

  if (/base game|buy now|add to cart|pre-purchase|purchase|owned|wishlist|get|checkout/.test(context)) {
    score += 8;
  }
  if (/offertype["':\s_]*base[_\s-]*game/.test(context)) {
    score += 18;
  }
  if (/price|sale price|current price|now available/.test(context)) {
    score += 4;
  }
  if (/sellingprice|pricecontainer|productupper|buyingoption|add to bag/.test(context)) {
    score += 16;
  }
  if (/save|discount|off\b|coupon|voucher|reward|cashback|xp|points|rating|reviews|star/.test(context)) {
    score -= 10;
  }
  if (/shipping|free shipping|below\s+(?:nz\$|a\$|au\$|us\$|\$|€|£)|\border\b|navbar|promotion|promo|banner|listitem/.test(context)) {
    score -= 18;
  }
  if (/deluxe edition|edition upgrade|add-on|addon|dlc|bundle includes|offertype["':\s_]*edition|offertype["':\s_]*dlc/.test(context)) {
    score -= 20;
  }
  if (/other sellers|no featured offers available|buying options|see all buying options/.test(context)) {
    score -= 18;
  }
  if (/\boption from\b|\bfrom \$|\bfrom [a-z]{3}\b/.test(context)) {
    score -= 14;
  }

  return score;
}

function scoreJsonPriceKey(key: string): number {
  const loweredKey = key.toLowerCase();
  if (loweredKey === "price") {
    return -10;
  }
  if (/discountprice|saleprice|currentprice|offerprice|sellingprice/.test(loweredKey)) {
    return 22;
  }
  if (/originalprice|regularprice|wasprice|compareatprice|listprice/.test(loweredKey)) {
    return -14;
  }
  const hasCurrentSignal = /current|sale|offer|promo|online|member|club/.test(loweredKey);
  const hasPriceSignal = /price/.test(loweredKey);
  const hasGenericValueSignal = /amount|value/.test(loweredKey);

  if (hasCurrentSignal && hasPriceSignal) {
    return 18;
  }
  if (hasCurrentSignal && hasGenericValueSignal) {
    return 7;
  }
  if (hasCurrentSignal) {
    return 8;
  }
  if (hasPriceSignal) {
    return 12;
  }
  if (hasGenericValueSignal) {
    return 4;
  }
  if (/cents|cent|minor/.test(loweredKey)) {
    return 18;
  }
  if (/was|original|regular|before|compare/.test(loweredKey)) {
    return -12;
  }
  return 0;
}

function scoreJsonContext(pageHtml: string, matchIndex: number, key: string): number {
  const context = pageHtml.slice(Math.max(0, matchIndex - 320), Math.min(pageHtml.length, matchIndex + 320)).toLowerCase();
  const loweredKey = key.toLowerCase();
  let score = 0;

  if (/totalprice|fmtprice|currencycode|discountprice|originalprice/.test(context)) {
    score += 12;
  }
  if (/base game|buy now|add to cart|purchasecta|purchase-cta|checkout|offertype["':\s_]*base[_\s-]*game/.test(context)) {
    score += 10;
  }
  if (/current|sale|offer|price specification|pricecurrency|in stock|available/.test(context) || /current|sale|offer/.test(loweredKey)) {
    score += 6;
  }
  if (/rewards?|earn\s+\d+%?\s*back|cashback|reward chip|membership discount|subscriber discount|points|xp/.test(context)) {
    score -= 24;
  }
  if (/discount|promo|promotion|special offer|voucher|coupon|rewards?/.test(context) || /discount|promo|promotion/.test(loweredKey)) {
    score -= 12;
  }
  if (/deluxe|upgrade|add-on|addon|dlc|bundle|edition|offertype["':\s_]*edition|offertype["':\s_]*dlc/.test(context) || /deluxe|upgrade|addon|bundle|edition/.test(loweredKey)) {
    score -= 10;
  }
  if (/pricevaliduntil|validuntil|startdate|purchasestateeffectivedate|scheduled|future|upcoming/.test(context) || /validuntil|startdate|future|scheduled/.test(loweredKey)) {
    score -= 16;
  }
  if (/was|original|regular|before|compare/.test(context) || /was|original|regular|before|compare/.test(loweredKey)) {
    score -= 16;
  }
  if (/other sellers|no featured offers available|buying options|see all buying options/.test(context)) {
    score -= 22;
  }
  if (/\bolpmessage\b|\boption from\b|\bfrom \$|\bfrom [a-z]{3}\b/.test(context) || /olp|option/.test(loweredKey)) {
    score -= 16;
  }

  return score;
}

function parseIsoDate(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function scoreOfferTiming(offer: Record<string, unknown>): number {
  const now = Date.now();
  let score = 0;

  const validFrom = parseIsoDate(offer.priceValidFrom)
    ?? parseIsoDate(offer.validFrom)
    ?? parseIsoDate(offer.startDate)
    ?? parseIsoDate(offer.startDateTime)
    ?? parseIsoDate(offer.effectiveDate)
    ?? parseIsoDate(offer.purchaseStateEffectiveDate);
  const validUntil = parseIsoDate(offer.priceValidUntil)
    ?? parseIsoDate(offer.validUntil)
    ?? parseIsoDate(offer.endDate)
    ?? parseIsoDate(offer.endDateTime)
    ?? parseIsoDate(offer.expiryDate)
    ?? parseIsoDate(offer.expirationDate);

  if (validFrom !== null) {
    if (validFrom > now + 60_000) {
      score -= 40;
    } else {
      score += 4;
    }
  }

  if (validUntil !== null) {
    if (validUntil < now - 60_000) {
      score -= 24;
    } else {
      score += 2;
    }
  }

  return score;
}

function scoreStructuredOfferContext(
  productName: string,
  candidateName: string,
  offer: Record<string, unknown>,
  rawCandidate: string
): number {
  let score = 0;
  const loweredProductName = productName.trim().toLowerCase();
  const loweredCandidateName = candidateName.trim().toLowerCase();
  const offerContext = JSON.stringify(offer).toLowerCase();
  const numericValue = Number.parseFloat(rawCandidate);

  score += scoreOfferTiming(offer);

  if (loweredProductName && loweredCandidateName) {
    if (loweredCandidateName === loweredProductName) {
      score += 12;
    } else if (loweredCandidateName.includes(loweredProductName) || loweredProductName.includes(loweredCandidateName)) {
      score += 5;
    } else {
      score -= 8;
    }
  }

  if (/base game/.test(offerContext)) {
    score += 10;
  }
  if (/deluxe|upgrade|add-on|addon|dlc|bundle|edition/.test(loweredCandidateName) || /deluxe|upgrade|add-on|addon|dlc|bundle|edition/.test(offerContext)) {
    score -= 12;
  }
  if (/sale|discount|promo|promotion|special offer|deal/.test(offerContext)) {
    score -= 8;
  }
  if (/scheduled|upcoming|future|prepurchase|pre-order|preorder|coming soon/.test(offerContext)) {
    score -= 14;
  }
  if (/in stock|instock|available|active/.test(offerContext)) {
    score += 4;
  }
  if (/outofstock|out of stock|unavailable|expired/.test(offerContext)) {
    score -= 16;
  }
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    score -= 40;
  }

  return score;
}

function detectContextMinorUnitScale(
  key: string,
  rawValue: string,
  context: string
): number | null {
  const normalizedValue = rawValue.trim();
  const numeric = Number.parseFloat(normalizedValue);
  const loweredKey = key.toLowerCase();
  const loweredContext = context.toLowerCase();

  if (normalizedValue.includes(".") || !/^\d+$/.test(normalizedValue) || !Number.isFinite(numeric) || numeric < 100) {
    return null;
  }

  const explicitDecimalsMatch = /"currencyinfo"\s*:\s*\{[^}]*"decimals"\s*:\s*(\d+)/i.exec(context);
  if (explicitDecimalsMatch) {
    const decimals = Number.parseInt(explicitDecimalsMatch[1] ?? "", 10);
    if (Number.isFinite(decimals) && decimals >= 0 && decimals <= 4) {
      return 10 ** decimals;
    }
  }

  if (
    /discountprice|originalprice|voucherdiscount/.test(loweredKey)
    && /"fmtprice"\s*:\s*\{[^}]*"(?:discountprice|originalprice|intermediateprice)"/i.test(context)
  ) {
    return 100;
  }

  if (
    /discountprice|originalprice/.test(loweredKey)
    && /"currencycode"\s*:\s*"[A-Z]{3}"/i.test(context)
    && /price"\s*:\s*\{[\s\S]{0,220}"totalprice"/i.test(loweredContext)
  ) {
    return 100;
  }

  return null;
}

function buildJsonPriceExtraction(key: string, rawValue: string, context: string): { previewRawText: string; previewPrice: string } | null {
  const normalizedValue = rawValue.trim();
  if (!normalizedValue) {
    return null;
  }

  const numeric = Number.parseFloat(normalizedValue);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  const loweredKey = key.toLowerCase();
  const contextMinorUnitScale = detectContextMinorUnitScale(key, normalizedValue, context);
  if (contextMinorUnitScale) {
    const converted = (numeric / contextMinorUnitScale).toFixed(2);
    return {
      previewRawText: converted,
      previewPrice: converted
    };
  }

  const looksLikeMinorUnitInteger = !normalizedValue.includes(".")
    && /^\d+$/.test(normalizedValue)
    && numeric >= 100
    && numeric <= 999999
    && /value|cents|cent|minor|amount/.test(loweredKey)
    && !/unitprice|priceper|weight|quantity|grams|kg|g$/.test(loweredKey);

  if (looksLikeMinorUnitInteger) {
    const converted = (numeric / 100).toFixed(2);
    return {
      previewRawText: converted,
      previewPrice: converted
    };
  }

  return {
    previewRawText: normalizedValue,
    previewPrice: buildPriceExtraction(normalizedValue).previewPrice
  };
}

function detectGenericPriceCandidate(pageHtml: string, $: cheerio.CheerioAPI): {
  selector?: string | null;
  attribute?: string | null;
  regex?: string | null;
  htmlRegex?: string | null;
  detectionSource: string;
  previewRawText: string;
  previewPrice: string;
  currency: string;
} | null {
  type Candidate = {
    selector?: string | null;
    attribute?: string | null;
    regex?: string | null;
    htmlRegex?: string | null;
    detectionSource: string;
    previewRawText: string;
    previewPrice: string;
    currency: string;
    score: number;
  };

  const candidates: Candidate[] = [];

  for (const selector of COMMON_PRICE_SELECTORS) {
    $(selector).slice(0, 8).each((index, element) => {
      const node = $(element);
      const { raw, attribute } = readCandidateRawText(node);
      if (!/\d/.test(raw) || !isPlausiblePriceText(raw)) {
        return;
      }

      try {
        const extraction = buildPriceExtraction(raw);
        let score = 10 - index;
        const loweredSelector = selector.toLowerCase();
        const loweredRaw = raw.toLowerCase();
        if (loweredSelector.includes("product")) score += 6;
        if (loweredSelector.includes("data-testid")) score += 3;
        if (attribute === "data-price") score += 8;
        if (node.parents("script,noscript,style").length > 0) score -= 8;
        if (/wishlist|discount|save|xp|rating|reviews|star/.test(loweredRaw)) score -= 6;
        if (/\bwas\b|previously|before/.test(loweredRaw)) score -= 14;
        if (/\bnow\b|current price|club price|special/.test(loweredRaw)) score += 8;
        if (/other sellers|buying options|option from|from \$|from [a-z]{3}\b/.test(loweredRaw)) score -= 18;
        if (/no featured offers available/.test(pageHtml.toLowerCase())) score -= 12;
        if (node.text().trim().length <= 18) score += 2;
        const hasInclusiveTaxLabel = /(?:inc|incl)\.?\s*(?:gst|vat|tax)\b|(?:including|with)\s+tax\b|tax\s*included\b|\bttc\b|\btva\s*incl(?:use)?\b/.test(loweredRaw);
        const hasExclusiveTaxLabel = /\+gst\b|ex\s*gst\b|excluding\s*gst\b|\+vat\b|ex\s*vat\b|excluding\s*vat\b|ex\s*tax\b|excluding\s*tax\b|tax\s*excluded\b/.test(loweredRaw);
        if (hasInclusiveTaxLabel) score += 8;
        if (hasExclusiveTaxLabel && !hasInclusiveTaxLabel) score -= 5;

        candidates.push({
          selector,
          attribute,
          regex: extraction.regex,
          detectionSource: `auto:${selector}`,
          previewRawText: raw,
          previewPrice: extraction.previewPrice,
          htmlRegex: null,
          currency: inferCurrencyFromText(raw),
          score
        });
      } catch {
        // ignore unusable candidate
      }
    });
  }

  const htmlPatterns = [
    {
      regex: /(?:Base\s+Game|Buy\s+Now|Add\s+To\s+Cart|Pre-Purchase|Wishlist)[\s\S]{0,400}?((?:NZ\$|A\$|AU\$|US\$|\$|€|£)\s*[0-9]+(?:\.[0-9]{2})?)/gi,
      source: "auto:purchase-text-price",
      score: 14
    },
    {
      regex: /((?:NZ\$|A\$|AU\$|US\$|\$|€|£)\s*[0-9]+(?:\.[0-9]{2})?)/gi,
      source: "auto:inline-currency-price",
      score: -2
    }
  ];

  for (const pattern of htmlPatterns) {
    for (const match of pageHtml.matchAll(pattern.regex)) {
      if (!match[1] || typeof match.index !== "number") {
        continue;
      }
      if (!isPlausiblePriceText(match[1])) {
        continue;
      }

      try {
        candidates.push({
          regex: null,
          htmlRegex: pattern.regex.source,
          detectionSource: pattern.source,
          previewRawText: match[1].trim(),
          previewPrice: buildPriceExtraction(match[1]).previewPrice,
          currency: inferCurrencyFromText(match[1]),
          score: pattern.score + scoreInlineCurrencyMatch(pageHtml, match.index, match[1])
        });
      } catch {
        // ignore unusable candidate
      }
    }
  }

  const jsonPricePatterns = [
    /"([A-Za-z0-9_]*?(?:price|amount|value)[A-Za-z0-9_]*)"\s*:\s*"?([0-9]+(?:\.[0-9]{2})?)"?/gi
  ];

  for (const pattern of jsonPricePatterns) {
    for (const match of pageHtml.matchAll(pattern)) {
      const key = match[1]?.trim() ?? "";
      const value = match[2]?.trim() ?? "";
      if (!key || !value) {
        continue;
      }
      if (!isPlausiblePriceText(value)) {
        continue;
      }

      try {
        const context = typeof match.index === "number"
          ? pageHtml.slice(Math.max(0, match.index - 320), Math.min(pageHtml.length, match.index + 320))
          : key;
        const extraction = buildJsonPriceExtraction(key, value, context);
        if (!extraction) {
          continue;
        }
        candidates.push({
          regex: null,
          htmlRegex: `"${key}"\\s*:\\s*"?([0-9]+(?:\\.[0-9]{2})?)"?`,
          detectionSource: "auto:json-price-key",
          previewRawText: extraction.previewRawText,
          previewPrice: extraction.previewPrice,
          currency: "",
          score: scoreJsonPriceKey(key) + (typeof match.index === "number" ? scoreJsonContext(pageHtml, match.index, key) : 0)
        });
      } catch {
        // ignore unusable candidate
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] ?? null;
}

function buildDetectionResult(input: {
  url: string;
  name: string;
  pageTitle: string | null;
  currency?: string;
  detectionSource: string;
  previewRawText: string;
  previewPrice: string;
}): DetectionResult {
  return {
    name: input.name,
    pageTitle: input.pageTitle,
    url: input.url,
    currency: input.currency ?? "",
    detectionSource: input.detectionSource,
    previewRawText: input.previewRawText,
    previewPrice: input.previewPrice
  };
}

type HtmlDetectionContext = {
  finalUrl: string;
  pageTitle: string | null;
  name: string;
  pageCurrency: string;
};

type DetectionCandidateKind = "captured-offer" | "generic" | "json-ld";

type DetectionCandidate = {
  kind: DetectionCandidateKind;
  result: DetectionResult;
};

function buildDetectionContext(finalUrl: string, html: string): HtmlDetectionContext {
  const $ = cheerio.load(html);
  const pageTitle = $("title").first().text().trim() || null;
  const blockedMessage = detectBlockedPageMessage(html, finalUrl, pageTitle ?? "");
  if (blockedMessage) {
    throw new AccessBlockedError(blockedMessage);
  }

  return {
    finalUrl,
    pageTitle,
    name: detectSpecificProductName(finalUrl, html, $, pageTitle || finalUrl),
    pageCurrency: detectCurrency(html, $)
  };
}

function collectDetectionCandidates(
  context: HtmlDetectionContext,
  html: string
): DetectionCandidate[] {
  const $ = cheerio.load(html);
  const candidates: DetectionCandidate[] = [];

  const capturedOfferPrice = detectCapturedOfferPrice(html, context.name);
  if (capturedOfferPrice) {
    candidates.push({
      kind: "captured-offer",
      result: buildDetectionResult({
        url: context.finalUrl,
        name: context.name,
        pageTitle: context.pageTitle,
        currency: capturedOfferPrice.currency || context.pageCurrency,
        detectionSource: "auto:captured-offer-price",
        previewRawText: capturedOfferPrice.previewRawText,
        previewPrice: capturedOfferPrice.previewPrice
      })
    });
  }

  const genericCandidate = detectGenericPriceCandidate(html, $);
  if (genericCandidate) {
    candidates.push({
      kind: "generic",
      result: buildDetectionResult({
        url: context.finalUrl,
        name: context.name,
        pageTitle: context.pageTitle,
        currency: genericCandidate.currency || context.pageCurrency,
        detectionSource: genericCandidate.detectionSource,
        previewRawText: genericCandidate.previewRawText,
        previewPrice: genericCandidate.previewPrice
      })
    });
  }

  const jsonLdPrice = detectJsonLdPrice(html);
  if (jsonLdPrice) {
    candidates.push({
      kind: "json-ld",
      result: buildDetectionResult({
        url: context.finalUrl,
        name: context.name,
        pageTitle: context.pageTitle,
        currency: jsonLdPrice.currency || context.pageCurrency,
        detectionSource: "auto:json-ld-price",
        previewRawText: jsonLdPrice.previewRawText,
        previewPrice: jsonLdPrice.previewPrice
      })
    });
  }

  return candidates;
}

function chooseBestDetectionCandidate(
  candidates: DetectionCandidate[],
  pageCurrency: string
): DetectionResult | null {
  const capturedCandidate = candidates.find((candidate) => candidate.kind === "captured-offer");
  if (capturedCandidate) {
    return capturedCandidate.result;
  }

  const genericCandidate = candidates.find((candidate) => candidate.kind === "generic");
  const jsonLdCandidate = candidates.find((candidate) => candidate.kind === "json-ld");
  const genericResult = genericCandidate?.result ?? null;
  const jsonLdResult = jsonLdCandidate?.result ?? null;

  if (genericResult && jsonLdResult) {
    const genericHasExplicitCurrency = hasExplicitCurrencyMarker(genericResult.previewRawText);
    const jsonLdHasExplicitCurrency = hasExplicitCurrencyMarker(jsonLdResult.previewRawText)
      || isSupportedCurrencyCode(jsonLdResult.currency);
    const pageHasExplicitCurrency = Boolean(pageCurrency);
    const genericMatchesPageCurrency = pageHasExplicitCurrency && genericResult.currency === pageCurrency;
    const jsonLdMatchesPageCurrency = pageHasExplicitCurrency && jsonLdResult.currency === pageCurrency;
    if (
      genericHasExplicitCurrency
      && genericResult.currency
      && jsonLdHasExplicitCurrency
      && jsonLdResult.currency
      && genericResult.currency !== jsonLdResult.currency
    ) {
      return genericResult;
    }
    if (genericMatchesPageCurrency && !jsonLdMatchesPageCurrency) {
      return genericResult;
    }
    return jsonLdResult;
  }

  if (jsonLdResult) {
    return jsonLdResult;
  }

  if (genericResult) {
    return genericResult;
  }

  return null;
}

function detectJsonLdPrice(html: string): { previewRawText: string; previewPrice: string; currency: string } | null {
  const scriptPattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  type Candidate = { previewRawText: string; previewPrice: string; currency: string; score: number };
  const candidates: Candidate[] = [];

  for (const match of html.matchAll(scriptPattern)) {
    const rawJson = match[1]?.trim();
    if (!rawJson) {
      continue;
    }

    try {
      const parsed = JSON.parse(rawJson) as unknown;
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of nodes) {
        if (!node || typeof node !== "object") {
          continue;
        }

        const offers = (node as { offers?: unknown }).offers;
      const offerNodes = Array.isArray(offers) ? offers : offers ? [offers] : [];
      const productName = typeof (node as { name?: unknown }).name === "string"
        ? (node as { name?: string }).name?.trim() ?? ""
        : "";
      for (const offer of offerNodes) {
        if (!offer || typeof offer !== "object") {
          continue;
        }

          const price = (offer as { price?: unknown }).price;
          const lowPrice = (offer as { lowPrice?: unknown }).lowPrice;
          const priceCurrency = (offer as { priceCurrency?: unknown }).priceCurrency;
          const rawCandidates = [price, lowPrice];
          for (const rawCandidate of rawCandidates) {
            if ((typeof rawCandidate === "string" || typeof rawCandidate === "number") && `${rawCandidate}`.trim()) {
              const normalized = `${rawCandidate}`.trim();
              const previewPrice = buildPriceExtraction(normalized).previewPrice;
              let score = 30;
              if (typeof price === "string" || typeof price === "number") {
                if (`${rawCandidate}` === `${price}`) {
                  score += 6;
                }
              }
              if (typeof lowPrice === "string" || typeof lowPrice === "number") {
                if (`${rawCandidate}` === `${lowPrice}`) {
                  score += 5;
                }
              }
              const offerName = typeof (offer as { name?: unknown }).name === "string"
                ? (offer as { name?: string }).name?.trim() ?? ""
                : "";
              score += scoreStructuredOfferContext(
                productName,
                offerName || productName,
                offer as Record<string, unknown>,
                previewPrice
              );
              candidates.push({
                previewRawText: normalized,
                previewPrice,
                currency: typeof priceCurrency === "string" ? priceCurrency.trim().toUpperCase() : "",
                score
              });
            }
          }
        }
      }
    } catch {
      // Ignore malformed JSON-LD blocks and keep scanning.
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const winner = candidates[0];
  return winner ? {
    previewRawText: winner.previewRawText,
    previewPrice: winner.previewPrice,
    currency: winner.currency
  } : null;
}

function normalizeFarmersVariant(variant: string): string {
  const parts = variant
    .split(",")
    .map((part) => part.trim())
    .map((part) => part.replace(/^[A-Za-z-]+:\s*/i, "").trim())
    .filter(Boolean);

  return parts.join(" / ");
}

function detectSpecificProductName(finalUrl: string, html: string, $: cheerio.CheerioAPI, fallbackName: string): string {
  const canonicalName = $("meta[property='og:title']").attr("content")?.trim()
    || $("h1").first().text().trim()
    || fallbackName;

  if (!/farmers\.co\.nz/i.test(finalUrl)) {
    return canonicalName;
  }

  const variantMatch = /"variant"\s*:\s*"([^"]+)"/i.exec(html);
  const normalizedVariant = variantMatch?.[1] ? normalizeFarmersVariant(variantMatch[1]) : "";
  if (!normalizedVariant) {
    return canonicalName;
  }

  const trimmedName = canonicalName.replace(/\s+Range$/i, "").trim();
  return `${trimmedName} - ${normalizedVariant}`;
}

function findCapturedCatalogOffers(node: unknown, results: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!node || typeof node !== "object") {
    return results;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      findCapturedCatalogOffers(item, results);
    }
    return results;
  }

  const record = node as Record<string, unknown>;
  const catalogOffer = record.catalogOffer;
  if (catalogOffer && typeof catalogOffer === "object" && !Array.isArray(catalogOffer)) {
    results.push(catalogOffer as Record<string, unknown>);
  }

  for (const value of Object.values(record)) {
    findCapturedCatalogOffers(value, results);
  }

  return results;
}

function extractCapturedOfferPrice(offer: Record<string, unknown>): {
  previewRawText: string;
  previewPrice: string;
  currency: string;
} | null {
  const price = offer.price;
  if (!price || typeof price !== "object" || Array.isArray(price)) {
    return null;
  }

  const totalPrice = (price as Record<string, unknown>).totalPrice;
  if (!totalPrice || typeof totalPrice !== "object" || Array.isArray(totalPrice)) {
    return null;
  }

  const totalPriceRecord = totalPrice as Record<string, unknown>;
  const fmtPrice = totalPriceRecord.fmtPrice;
  const currencyCode = typeof totalPriceRecord.currencyCode === "string"
    ? totalPriceRecord.currencyCode.trim().toUpperCase()
    : "";
  const decimals = typeof (totalPriceRecord.currencyInfo as { decimals?: unknown } | undefined)?.decimals === "number"
    ? (totalPriceRecord.currencyInfo as { decimals: number }).decimals
    : 2;

  if (fmtPrice && typeof fmtPrice === "object" && !Array.isArray(fmtPrice)) {
    const discountPrice = (fmtPrice as Record<string, unknown>).discountPrice;
    const originalPrice = (fmtPrice as Record<string, unknown>).originalPrice;
    for (const candidate of [discountPrice, originalPrice]) {
      if (typeof candidate === "string" && candidate.trim()) {
        const previewRawText = candidate.trim();
        return {
          previewRawText,
          previewPrice: buildPriceExtraction(previewRawText).previewPrice,
          currency: currencyCode
        };
      }
    }
  }

  for (const candidate of ["discountPrice", "originalPrice"] as const) {
    const rawValue = totalPriceRecord[candidate];
    if (typeof rawValue === "number" && Number.isFinite(rawValue) && rawValue > 0) {
      const converted = (rawValue / 10 ** decimals).toFixed(decimals);
      return {
        previewRawText: converted,
        previewPrice: converted,
        currency: currencyCode
      };
    }
  }

  return null;
}

function detectCapturedOfferPrice(
  html: string,
  productName: string
): { previewRawText: string; previewPrice: string; currency: string } | null {
  const scriptPattern = /<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  type Candidate = { previewRawText: string; previewPrice: string; currency: string; score: number };
  const candidates: Candidate[] = [];

  for (const match of html.matchAll(scriptPattern)) {
    const rawJson = match[1]?.trim();
    if (!rawJson) {
      continue;
    }

    try {
      const parsed = JSON.parse(rawJson) as unknown;
      const offers = findCapturedCatalogOffers(parsed);
      for (const offer of offers) {
        const extracted = extractCapturedOfferPrice(offer);
        if (!extracted) {
          continue;
        }

        const offerName = typeof offer.title === "string"
          ? offer.title.trim()
          : typeof offer.productSlug === "string"
            ? offer.productSlug.trim()
            : productName;
        const score = 80 + scoreStructuredOfferContext(
          productName,
          offerName,
          offer,
          extracted.previewPrice
        );

        candidates.push({
          ...extracted,
          score
        });
      }
    } catch {
      // Ignore malformed JSON blocks and keep scanning.
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const winner = candidates[0];
  return winner ? {
    previewRawText: winner.previewRawText,
    previewPrice: winner.previewPrice,
    currency: winner.currency
  } : null;
}

function logScrapeEvent(event: string, input: Record<string, string | null | undefined>): void {
  const payload = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, value ?? ""])
  );
  console.info(`[scraper:${event}] ${JSON.stringify(payload)}`);
}

function pushScrapeDebugEvent(
  events: Array<{ step: string; detail: string }>,
  step: string,
  detail: string
): void {
  events.push({ step, detail });
}

function shouldTryBrowserForHttpPage(rawUrl: string, page: { html: string; url: string }): {
  shouldTry: boolean;
  blockedMessage: string | null;
} {
  const pageTitle = /<title[^>]*>(.*?)<\/title>/i.exec(page.html)?.[1]?.trim() ?? "";
  const blockedMessage = detectBlockedPageMessage(page.html, page.url, pageTitle);
  return {
    shouldTry: Boolean(blockedMessage) || shouldUseBrowserFallbackForHtml(rawUrl, page.html, page.url),
    blockedMessage
  };
}

async function fetchHtmlViaRegionalProxy(
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

  if (payload.blocked) {
    const title = /<title[^>]*>(.*?)<\/title>/i.exec(payload.html)?.[1]?.trim() ?? "";
    const blockedMessage = detectBlockedPageMessage(payload.html, payload.finalUrl, title);
    if (blockedMessage) {
      throw new AccessBlockedError(blockedMessage);
    }
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
    return await fetchHtmlViaRegionalProxy(rawUrl, preferredRegion, "http");
  } catch {
    return fetchHtmlViaRegionalProxy(rawUrl, preferredRegion, "browser");
  }
}

async function fetchHtmlWithPreferences(
  rawUrl: string,
  headersJson: string | null,
  scrapePreferences: ScrapePreferences | null
): Promise<{
  html: string;
  url: string;
  fetchMode: FetchMode;
}> {
  const headers = parseHeaders(headersJson);
  if (!headers.Referer) {
    const referer = defaultReferer(rawUrl);
    if (referer) {
      headers.Referer = referer;
    }
  }

  try {
    const page = await fetchHtmlWithHttp(rawUrl, headers, scrapePreferences);
    const { shouldTry, blockedMessage } = shouldTryBrowserForHttpPage(rawUrl, page);
    if (shouldTry) {
      try {
        const browserPage = await fetchHtmlWithBrowser(rawUrl, headers, scrapePreferences);
        return { ...browserPage, fetchMode: "browser" };
      } catch (browserError) {
        if (browserError instanceof AccessBlockedError) {
          throw browserError;
        }
        if (blockedMessage) {
          throw new AccessBlockedError(blockedMessage);
        }
        throw browserError;
      }
    }
    return { ...page, fetchMode: "http" };
  } catch (error) {
    if (error instanceof AccessBlockedError) {
      try {
        return await fetchHtmlWithRegionalFallback(rawUrl, scrapePreferences);
      } catch {
        throw error;
      }
    }
    if (shouldUseBrowserFallback(error)) {
      try {
        const page = await fetchHtmlWithBrowser(rawUrl, headers, scrapePreferences);
        return { ...page, fetchMode: "browser" };
      } catch (browserError) {
        try {
          return await fetchHtmlWithRegionalFallback(rawUrl, scrapePreferences);
        } catch {
          throw browserError;
        }
      }
    }
    try {
      return await fetchHtmlWithRegionalFallback(rawUrl, scrapePreferences);
    } catch {
      throw error;
    }
  }
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
  const headers = parseHeaders(null);
  if (!headers.Referer) {
    const referer = defaultReferer(rawUrl);
    if (referer) {
      headers.Referer = referer;
    }
  }
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
  const tryRegionalFallback = async (reason: string): Promise<ScrapeDebugResult | null> => {
    if (!inferPreferredRegion(scrapePreferences)) {
      return null;
    }

    try {
      pushScrapeDebugEvent(events, "regional-fetch", `Attempting regional fallback because ${reason}.`);
      const regionalPage = await fetchHtmlWithRegionalFallback(rawUrl, scrapePreferences);
      pushScrapeDebugEvent(events, "regional-fetch", `Regional fetch succeeded with final URL ${regionalPage.url}.`);
      return buildScrapeDebugResult(rawUrl, regionalPage, scrapePreferences, headers, true, events);
    } catch (regionalError) {
      pushScrapeDebugEvent(
        events,
        "regional-fetch",
        `Regional fallback failed: ${regionalError instanceof Error ? regionalError.message : String(regionalError)}`
      );
      return null;
    }
  };

  try {
    pushScrapeDebugEvent(events, "http-fetch", "Attempting standard HTTP fetch.");
    const httpPage = await fetchHtmlWithHttp(rawUrl, headers, scrapePreferences);
    pushScrapeDebugEvent(events, "http-fetch", `HTTP fetch succeeded with final URL ${httpPage.url}.`);
    const { shouldTry, blockedMessage } = shouldTryBrowserForHttpPage(rawUrl, httpPage);
    pushScrapeDebugEvent(
      events,
      "http-evaluation",
      shouldTry
        ? `Browser fallback suggested${blockedMessage ? ` because: ${blockedMessage}` : " due to page heuristics"}.`
        : "HTTP result looked usable without browser fallback."
    );
    if (shouldTry) {
      try {
        pushScrapeDebugEvent(events, "browser-fetch", "Attempting browser fetch after HTTP evaluation.");
        const browserPage = await fetchHtmlWithBrowser(rawUrl, headers, scrapePreferences);
        pushScrapeDebugEvent(events, "browser-fetch", `Browser fetch succeeded with final URL ${browserPage.url}.`);
        return buildScrapeDebugResult(rawUrl, { ...browserPage, fetchMode: "browser" }, scrapePreferences, headers, shouldTry, events);
      } catch (browserError) {
        pushScrapeDebugEvent(
          events,
          "browser-fetch",
          `Browser fetch failed: ${browserError instanceof Error ? browserError.message : String(browserError)}`
        );
        const regionalResult = await tryRegionalFallback("browser fetch failed after HTTP evaluation");
        if (regionalResult) {
          return regionalResult;
        }
        return {
          ...buildScrapeDebugResult(rawUrl, { ...httpPage, fetchMode: "http" }, scrapePreferences, headers, shouldTry, events),
          errorMessage: browserError instanceof Error ? browserError.message : String(browserError)
        };
      }
    }

    return buildScrapeDebugResult(rawUrl, { ...httpPage, fetchMode: "http" }, scrapePreferences, headers, shouldTry, events);
  } catch (error) {
    if (shouldUseBrowserFallback(error)) {
      try {
        pushScrapeDebugEvent(
          events,
          "http-fetch",
          `HTTP fetch failed with browser-fallback-eligible error: ${error instanceof Error ? error.message : String(error)}`
        );
        pushScrapeDebugEvent(events, "browser-fetch", "Attempting browser fetch after HTTP failure.");
        const browserPage = await fetchHtmlWithBrowser(rawUrl, headers, scrapePreferences);
        pushScrapeDebugEvent(events, "browser-fetch", `Browser fetch succeeded with final URL ${browserPage.url}.`);
        return buildScrapeDebugResult(rawUrl, { ...browserPage, fetchMode: "browser" }, scrapePreferences, headers, true, events);
      } catch (browserError) {
        pushScrapeDebugEvent(
          events,
          "browser-fetch",
          `Browser fetch failed: ${browserError instanceof Error ? browserError.message : String(browserError)}`
        );
        const regionalResult = await tryRegionalFallback("browser fetch failed after HTTP transport error");
        if (regionalResult) {
          return regionalResult;
        }
        return {
          inputUrl: rawUrl,
          finalUrl: null,
          fetchMode: null,
          pageTitle: null,
          blockedMessage: null,
          errorMessage: browserError instanceof Error ? browserError.message : String(browserError),
          html: null,
          htmlBytes: null,
          scrapePreferences,
          inferredRegion: inferPreferredRegion(scrapePreferences),
          requestHeaders: headers,
          browserFallbackSuggested: true,
          detection: null,
          events
        };
      }
    }

    pushScrapeDebugEvent(
      events,
      "http-fetch",
      `Scrape failed before a usable page was returned: ${error instanceof Error ? error.message : String(error)}`
    );
    const regionalResult = await tryRegionalFallback("local scraping failed");
    if (regionalResult) {
      return regionalResult;
    }
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
  let page = await fetchHtmlWithPreferences(rawUrl, null, scrapePreferences);
  let result = detectTrackedItemFromHtml(page.url, page.html);

  if (
    (page.fetchMode === "http" || page.fetchMode === "browser")
    && shouldPreferNzRegionalFallback(scrapePreferences, result)
  ) {
    try {
      const regionalPage = await fetchHtmlWithRegionalFallback(rawUrl, scrapePreferences, result.currency);
      const regionalResult = detectTrackedItemFromHtml(regionalPage.url, regionalPage.html);
      if (regionalResult.currency === "NZD") {
        page = regionalPage;
        result = regionalResult;
      }
    } catch {
      // Keep the local result if the regional fallback cannot improve it.
    }
  }

  logScrapeEvent("detect", {
    inputUrl: rawUrl,
    finalUrl: page.url,
    fetchMode: page.fetchMode,
    detectionSource: result.detectionSource,
    previewRawText: result.previewRawText,
    previewPrice: result.previewPrice,
    currency: result.currency
  });
  return result;
}

export function detectTrackedItemFromHtml(finalUrl: string, html: string): DetectionResult {
  const context = buildDetectionContext(finalUrl, html);
  const candidates = collectDetectionCandidates(context, html);
  const winner = chooseBestDetectionCandidate(candidates, context.pageCurrency);
  if (winner) {
    return winner;
  }

  throw new Error("Could not automatically detect a price on this page yet.");
}

export async function fetchTrackedItemCheck(
  item: TrackedItemRecord,
  scrapePreferences: ScrapePreferences | null = null
): Promise<{
  status: "ok" | "error";
  checkedAt: string;
  price?: string | null;
  currency?: string | null;
  rawText?: string | null;
  errorMessage?: string | null;
}> {
  try {
    let page = await fetchHtmlWithPreferences(item.url, item.headersJson, scrapePreferences);
    let { rawText, price, currency } = extractTrackedItemCheckDataFromHtml(item, page.html);

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

        if (
          regionalCurrency === "NZD"
          || (!currency && regionalCurrency)
        ) {
          page = regionalPage;
          rawText = regionalRawText;
          price = regionalPrice;
          currency = regionalCurrency;
        }
      } catch {
        // Keep the local result if the regional fallback cannot improve it.
      }
    }

    logScrapeEvent("check", {
      inputUrl: item.url,
      finalUrl: page.url,
      fetchMode: page.fetchMode,
      detectionSource: item.detectionSource,
      rawText,
      price,
      currency: currency ?? item.currency
    });

    return {
      status: "ok",
      checkedAt: utcNow(),
      price,
      currency: currency ?? item.currency,
      rawText
    };
  } catch (error) {
    logScrapeEvent("check-error", {
      inputUrl: item.url,
      detectionSource: item.detectionSource,
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    return {
      status: "error",
      checkedAt: utcNow(),
      errorMessage: error instanceof Error ? error.message : String(error)
    };
  }
}
