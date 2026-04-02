import { HttpStatusError } from "./errors.js";

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

export function shouldUseBrowserFallbackForHtml(rawUrl: string, html: string, finalUrl: string): boolean {
  if (/product:price|pricecurrency|itemprop=["']price["']|data-price|schema\.org\/product/i.test(html)) {
    return false;
  }

  return countShellSignals(rawUrl, html, finalUrl) >= 4;
}

export function shouldUseBrowserFallback(error: unknown): boolean {
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

export function detectBlockedPageMessage(html: string, pageUrl: string, title: string): string | null {
  const lowered = `${title}\n${pageUrl}\n${html.slice(0, 16000)}`.toLowerCase();

  if (/\/waf_deny_page\/|temporarily down|error code:\s*#\d+|access denied/.test(lowered)) {
    return "This retailer is blocking automated access right now, so PriceBuzz could not load the real product page.";
  }

  if (/captcha|verify you are human|unusual traffic|bot detection|just a moment|enable javascript|enable cookies/.test(lowered)) {
    return "This retailer is challenging automated traffic right now, so PriceBuzz could not load the real product page.";
  }

  return null;
}

export function isBrowserChallengePage(html: string, pageUrl: string, title: string): boolean {
  const lowered = `${title}\n${pageUrl}\n${html.slice(0, 12000)}`.toLowerCase();
  return /captcha|verify you are human|access denied|temporarily blocked|unusual traffic|enable javascript|enable cookies|akamai|bot detection|just a moment/.test(lowered);
}

export function hasEmbeddedPriceSignals(html: string): boolean {
  return /product:price|pricecurrency|itemprop=["']price["']|data-price|schema\.org\/product|"price"\s*:|price__dollars|price__cents/i.test(html);
}

export function shouldTryBrowserForHttpPage(rawUrl: string, page: { html: string; url: string }): {
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
