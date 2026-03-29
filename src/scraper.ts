import * as cheerio from "cheerio";
import { config } from "./config.js";
import { utcNow } from "./utils.js";
import type { DetectionResult, ScrapePreferences, TrackedItemRecord } from "./types.js";

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
  const match = /-?\d+(?:\.\d+)?/.exec(normalized);
  if (!match) {
    throw new Error(`Could not parse numeric price from: ${priceText}`);
  }

  return Number.parseFloat(match[0]).toFixed(2);
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

function extractPriceText(item: TrackedItemRecord, html: string): string {
  if (item.htmlRegex) {
    const match = new RegExp(item.htmlRegex).exec(html);
    if (!match) {
      throw new Error(`HTML regex did not match page: ${item.htmlRegex}`);
    }
    return (match[1] ?? match[0]).trim();
  }

  if (!item.selector) {
    throw new Error("Either selector or htmlRegex is required");
  }

  const $ = cheerio.load(html);
  const node = $(item.selector).first();
  if (node.length === 0) {
    throw new Error(`CSS selector did not match any node: ${item.selector}`);
  }

  if (item.attribute) {
    const value = node.attr(item.attribute);
    if (!value) {
      throw new Error(`Attribute '${item.attribute}' was not present on the matched element`);
    }
    return value.trim();
  }

  return node.text().trim();
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutSeconds * 1000);

  try {
    const response = await fetch(rawUrl, {
      headers: buildScrapeHeaders(headers, scrapePreferences),
      signal: controller.signal
    });

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
  } finally {
    clearTimeout(timeout);
  }
}

function shouldUseBrowserFallback(error: unknown): boolean {
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

async function fetchHtmlWithBrowser(
  rawUrl: string,
  headers: Record<string, string>,
  scrapePreferences: ScrapePreferences | null
): Promise<{ html: string; url: string }> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    const context = await browser.newContext({
      userAgent: config.userAgent,
      ...(scrapePreferences?.browserLocale?.trim() ? { locale: scrapePreferences.browserLocale.trim() } : {}),
      ...(scrapePreferences?.browserTimezone?.trim() ? { timezoneId: scrapePreferences.browserTimezone.trim() } : {})
    });

    const page = await context.newPage();
    await page.setExtraHTTPHeaders(buildScrapeHeaders(headers, scrapePreferences));
    await page.goto(rawUrl, {
      waitUntil: "domcontentloaded",
      timeout: config.timeoutSeconds * 1000
    });
    await page.waitForLoadState("networkidle", { timeout: config.timeoutSeconds * 1000 }).catch(() => undefined);

    return {
      html: await page.content(),
      url: page.url()
    };
  } finally {
    await browser.close();
  }
}

function detectCurrency(html: string, $: cheerio.CheerioAPI): string {
  const metaCurrency = $("meta[property='product:price:currency']").attr("content")
    || $("meta[itemprop='priceCurrency']").attr("content");
  if (metaCurrency) {
    return metaCurrency.trim().toUpperCase();
  }

  if (/NZ\$|NZD/.test(html)) {
    return "NZD";
  }
  if (/A\$|AU\$|AUD/.test(html)) {
    return "AUD";
  }
  if (/AU\$|AUD/.test(html)) {
    return "AUD";
  }
  if (/\$/.test(html)) {
    return "USD";
  }

  return "";
}

function inferCurrencyFromText(value: string): string {
  if (/NZ\$|NZD/i.test(value)) {
    return "NZD";
  }
  if (/A\$|AU\$|AUD/i.test(value)) {
    return "AUD";
  }
  if (/US\$|USD/i.test(value)) {
    return "USD";
  }
  if (/€|EUR/i.test(value)) {
    return "EUR";
  }
  if (/£|GBP/i.test(value)) {
    return "GBP";
  }
  return "";
}

function scoreInlineCurrencyMatch(pageHtml: string, startIndex: number, rawText: string): number {
  const context = pageHtml.slice(Math.max(0, startIndex - 240), Math.min(pageHtml.length, startIndex + 240)).toLowerCase();
  let score = 0;

  if (/nz\$|nzd|a\$|au\$|aud|us\$|usd|€|eur|£|gbp/i.test(rawText)) {
    score += 8;
  } else if (/^\s*\$\s*/.test(rawText)) {
    score -= 6;
  }

  if (/base game|buy now|add to cart|pre-purchase|purchase|owned|wishlist|get|checkout/.test(context)) {
    score += 8;
  }
  if (/price|sale price|current price|now available/.test(context)) {
    score += 4;
  }
  if (/save|discount|off\b|coupon|voucher|reward|cashback|xp|points|rating|reviews|star/.test(context)) {
    score -= 10;
  }
  if (/edition upgrade|add-on|dlc|bundle includes/.test(context)) {
    score -= 4;
  }

  return score;
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
      const attribute = node.is("meta") ? "content" : null;
      const raw = (attribute ? node.attr(attribute) ?? "" : node.text()).trim();
      if (!/\d/.test(raw)) {
        return;
      }

      try {
        const extraction = buildPriceExtraction(raw);
        let score = 10 - index;
        const loweredSelector = selector.toLowerCase();
        const loweredRaw = raw.toLowerCase();
        if (loweredSelector.includes("product")) score += 6;
        if (loweredSelector.includes("data-testid")) score += 3;
        if (node.parents("script,noscript,style").length > 0) score -= 8;
        if (/wishlist|discount|save|xp|rating|reviews|star/.test(loweredRaw)) score -= 6;
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

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] ?? null;
}

function buildDetectionResult(input: {
  url: string;
  name: string;
  pageTitle: string | null;
  selector?: string | null;
  attribute?: string | null;
  regex?: string | null;
  htmlRegex?: string | null;
  currency?: string;
  detectionSource: string;
  previewRawText: string;
  previewPrice: string;
}): DetectionResult {
  return {
    name: input.name,
    pageTitle: input.pageTitle,
    url: input.url,
    selector: input.selector ?? null,
    currency: input.currency ?? "",
    attribute: input.attribute ?? null,
    regex: input.regex ?? null,
    htmlRegex: input.htmlRegex ?? null,
    detectionSource: input.detectionSource,
    previewRawText: input.previewRawText,
    previewPrice: input.previewPrice
  };
}

function logScrapeEvent(event: string, input: Record<string, string | null | undefined>): void {
  const payload = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, value ?? ""])
  );
  console.info(`[scraper:${event}] ${JSON.stringify(payload)}`);
}

async function fetchHtmlWithPreferences(
  rawUrl: string,
  headersJson: string | null,
  scrapePreferences: ScrapePreferences | null
): Promise<{
  html: string;
  url: string;
  fetchMode: "http" | "browser";
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
    return { ...page, fetchMode: "http" };
  } catch (error) {
    if (shouldUseBrowserFallback(error)) {
      const page = await fetchHtmlWithBrowser(rawUrl, headers, scrapePreferences);
      return { ...page, fetchMode: "browser" };
    }
    throw error;
  }
}

export async function detectTrackedItem(rawUrl: string, scrapePreferences: ScrapePreferences | null = null): Promise<DetectionResult> {
  const page = await fetchHtmlWithPreferences(rawUrl, null, scrapePreferences);
  const $ = cheerio.load(page.html);
  const pageTitle = $("title").first().text().trim() || null;
  const name = $("meta[property='og:title']").attr("content")?.trim()
    || $("h1").first().text().trim()
    || pageTitle
    || page.url;
  const pageCurrency = detectCurrency(page.html, $);
  const genericCandidate = detectGenericPriceCandidate(page.html, $);
  if (genericCandidate) {
    const result = buildDetectionResult({
      url: page.url,
      name,
      pageTitle,
      selector: genericCandidate.selector ?? null,
      attribute: genericCandidate.attribute ?? null,
      regex: genericCandidate.regex ?? null,
      htmlRegex: genericCandidate.htmlRegex ?? null,
      currency: genericCandidate.currency || pageCurrency,
      detectionSource: genericCandidate.detectionSource,
      previewRawText: genericCandidate.previewRawText,
      previewPrice: genericCandidate.previewPrice
    });
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

  const jsonLdMatch = /"price"\s*:\s*"?([0-9]+(?:\.\d+)?)"?/i.exec(page.html);
  if (jsonLdMatch) {
    const previewRawText = jsonLdMatch[1];
    const result = buildDetectionResult({
      url: page.url,
      name,
      pageTitle,
      currency: pageCurrency,
      htmlRegex: "\"price\"\\s*:\\s*\"?([0-9]+(?:\\.[0-9]+)?)\"?",
      detectionSource: "auto:json-ld-price",
      previewRawText,
      previewPrice: normalizePrice(previewRawText, null)
    });
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

  logScrapeEvent("detect-miss", {
    inputUrl: rawUrl,
    finalUrl: page.url,
    fetchMode: page.fetchMode,
    pageTitle
  });
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
    const page = await fetchHtmlWithPreferences(item.url, item.headersJson, scrapePreferences);
    const rawText = extractPriceText(item, page.html);
    const price = normalizePrice(rawText, item.regex);
    logScrapeEvent("check", {
      inputUrl: item.url,
      finalUrl: page.url,
      fetchMode: page.fetchMode,
      detectionSource: item.detectionSource,
      rawText,
      price,
      currency: item.currency
    });

    return {
      status: "ok",
      checkedAt: utcNow(),
      price,
      currency: item.currency,
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
