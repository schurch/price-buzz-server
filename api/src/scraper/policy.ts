import type { DetectionResult, ScrapePreferences } from "../types.js";

export function inferPreferredRegion(scrapePreferences: ScrapePreferences | null): "nz" | null {
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

export function shouldPreferNzRegionalFallback(
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

export function shouldRetryTrackedItemCheckWithRegional(
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
