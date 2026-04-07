import * as cheerio from "cheerio";

import { detectBlockedPageMessage } from "./blocking.js";
import { AccessBlockedError } from "./errors.js";
import type { AvailabilityStatus, DetectionResult, TrackedItemRecord } from "../types.js";

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

function inferCurrencyFromText(value: string): string {
  return extractCurrencyCode(value);
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

const PRICE_SCORE = {
  inlineCurrencyExplicit: 8,
  inlineCurrencyAmbiguousDollar: -6,
  purchaseContext: 8,
  baseGameOfferType: 18,
  inlineCurrentPriceContext: 4,
  inlineStrongPurchaseContext: 16,
  inlineDiscountNoise: -10,
  inlineLayoutNoise: -18,
  inlineEditionPenalty: -20,
  inlineOtherSellersPenalty: -18,
  inlineOptionFromPenalty: -14,
  genericPriceKey: -10,
  genericCurrentPriceKey: 22,
  genericOriginalPriceKey: -14,
  currentPriceAndSignal: 18,
  currentValueSignal: 7,
  currentSignalOnly: 8,
  priceSignalOnly: 12,
  genericValueSignal: 4,
  minorUnitSignal: 18,
  originalPriceSignal: -12,
  jsonStructuredPriceContext: 12,
  jsonPurchaseContext: 10,
  jsonAvailabilityContext: 6,
  jsonRewardsPenalty: -24,
  jsonDiscountPenalty: -12,
  jsonEditionPenalty: -10,
  jsonFuturePenalty: -16,
  jsonOriginalPricePenalty: -16,
  jsonOtherSellersPenalty: -22,
  jsonOptionPenalty: -16,
  offerFuturePenalty: -40,
  offerCurrentBonus: 4,
  offerExpiredPenalty: -24,
  offerValidUntilBonus: 2,
  nameExactMatch: 12,
  namePartialMatch: 5,
  nameMismatchPenalty: -8,
  structuredBaseGameBonus: 10,
  structuredEditionPenalty: -12,
  structuredDiscountPenalty: -8,
  structuredFuturePenalty: -14,
  structuredAvailabilityBonus: 4,
  structuredUnavailablePenalty: -16,
  invalidNumericPenalty: -40,
  genericSelectorBase: 10,
  genericSelectorProductBonus: 6,
  genericSelectorTestIdBonus: 3,
  genericSelectorDataPriceBonus: 8,
  genericSelectorHiddenPenalty: -8,
  genericSelectorNoisePenalty: -6,
  genericSelectorWasPricePenalty: -14,
  genericSelectorCurrentPriceBonus: 8,
  genericSelectorOptionPenalty: -18,
  genericSelectorNoOffersPenalty: -12,
  genericSelectorCompactTextBonus: 2,
  inclusiveTaxBonus: 8,
  exclusiveTaxPenalty: -5,
  purchaseTextPattern: 14,
  inlineCurrencyPattern: -2,
  jsonLdBase: 30,
  jsonLdPrimaryPriceBonus: 6,
  jsonLdLowPriceBonus: 5,
  capturedOfferBase: 80
} as const;

function scoreInlineCurrencyMatch(pageHtml: string, startIndex: number, rawText: string): number {
  const context = pageHtml.slice(Math.max(0, startIndex - 240), Math.min(pageHtml.length, startIndex + 240)).toLowerCase();
  let score = 0;

  if (/nz\$|nzd|a\$|au\$|aud|us\$|usd|c\$|cad|s\$|sgd|hk\$|hkd|¥|jpy|chf|€|eur|£|gbp/i.test(rawText)) {
    score += PRICE_SCORE.inlineCurrencyExplicit;
  } else if (/^\s*\$\s*/.test(rawText)) {
    score += PRICE_SCORE.inlineCurrencyAmbiguousDollar;
  }

  if (/base game|buy now|add to cart|pre-purchase|purchase|owned|wishlist|get|checkout/.test(context)) {
    score += PRICE_SCORE.purchaseContext;
  }
  if (/offertype["':\s_]*base[_\s-]*game/.test(context)) {
    score += PRICE_SCORE.baseGameOfferType;
  }
  if (/price|sale price|current price|now available/.test(context)) {
    score += PRICE_SCORE.inlineCurrentPriceContext;
  }
  if (/sellingprice|pricecontainer|productupper|buyingoption|add to bag/.test(context)) {
    score += PRICE_SCORE.inlineStrongPurchaseContext;
  }
  if (/save|discount|off\b|coupon|voucher|reward|cashback|xp|points|rating|reviews|star/.test(context)) {
    score += PRICE_SCORE.inlineDiscountNoise;
  }
  if (/shipping|free shipping|below\s+(?:nz\$|a\$|au\$|us\$|\$|€|£)|\border\b|navbar|promotion|promo|banner|listitem/.test(context)) {
    score += PRICE_SCORE.inlineLayoutNoise;
  }
  if (/deluxe edition|edition upgrade|add-on|addon|dlc|bundle includes|offertype["':\s_]*edition|offertype["':\s_]*dlc/.test(context)) {
    score += PRICE_SCORE.inlineEditionPenalty;
  }
  if (/other sellers|no featured offers available|buying options|see all buying options/.test(context)) {
    score += PRICE_SCORE.inlineOtherSellersPenalty;
  }
  if (/\boption from\b|\bfrom \$|\bfrom [a-z]{3}\b/.test(context)) {
    score += PRICE_SCORE.inlineOptionFromPenalty;
  }

  return score;
}

function scoreJsonPriceKey(key: string): number {
  const loweredKey = key.toLowerCase();
  if (loweredKey === "price") {
    return PRICE_SCORE.genericPriceKey;
  }
  if (/discountprice|saleprice|currentprice|offerprice|sellingprice/.test(loweredKey)) {
    return PRICE_SCORE.genericCurrentPriceKey;
  }
  if (/originalprice|regularprice|wasprice|compareatprice|listprice/.test(loweredKey)) {
    return PRICE_SCORE.genericOriginalPriceKey;
  }
  const hasCurrentSignal = /current|sale|offer|promo|online|member|club/.test(loweredKey);
  const hasPriceSignal = /price/.test(loweredKey);
  const hasGenericValueSignal = /amount|value/.test(loweredKey);

  if (hasCurrentSignal && hasPriceSignal) return PRICE_SCORE.currentPriceAndSignal;
  if (hasCurrentSignal && hasGenericValueSignal) return PRICE_SCORE.currentValueSignal;
  if (hasCurrentSignal) return PRICE_SCORE.currentSignalOnly;
  if (hasPriceSignal) return PRICE_SCORE.priceSignalOnly;
  if (hasGenericValueSignal) return PRICE_SCORE.genericValueSignal;
  if (/cents|cent|minor/.test(loweredKey)) return PRICE_SCORE.minorUnitSignal;
  if (/was|original|regular|before|compare/.test(loweredKey)) return PRICE_SCORE.originalPriceSignal;
  return 0;
}

function scoreJsonContext(pageHtml: string, matchIndex: number, key: string): number {
  const context = pageHtml.slice(Math.max(0, matchIndex - 320), Math.min(pageHtml.length, matchIndex + 320)).toLowerCase();
  const loweredKey = key.toLowerCase();
  let score = 0;

  if (/totalprice|fmtprice|currencycode|discountprice|originalprice/.test(context)) score += PRICE_SCORE.jsonStructuredPriceContext;
  if (/base game|buy now|add to cart|purchasecta|purchase-cta|checkout|offertype["':\s_]*base[_\s-]*game/.test(context)) score += PRICE_SCORE.jsonPurchaseContext;
  if (/current|sale|offer|price specification|pricecurrency|in stock|available/.test(context) || /current|sale|offer/.test(loweredKey)) score += PRICE_SCORE.jsonAvailabilityContext;
  if (/rewards?|earn\s+\d+%?\s*back|cashback|reward chip|membership discount|subscriber discount|points|xp/.test(context)) score += PRICE_SCORE.jsonRewardsPenalty;
  if (/discount|promo|promotion|special offer|voucher|coupon|rewards?/.test(context) || /discount|promo|promotion/.test(loweredKey)) score += PRICE_SCORE.jsonDiscountPenalty;
  if (/deluxe|upgrade|add-on|addon|dlc|bundle|edition|offertype["':\s_]*edition|offertype["':\s_]*dlc/.test(context) || /deluxe|upgrade|addon|bundle|edition/.test(loweredKey)) score += PRICE_SCORE.jsonEditionPenalty;
  if (/pricevaliduntil|validuntil|startdate|purchasestateeffectivedate|scheduled|future|upcoming/.test(context) || /validuntil|startdate|future|scheduled/.test(loweredKey)) score += PRICE_SCORE.jsonFuturePenalty;
  if (/was|original|regular|before|compare/.test(context) || /was|original|regular|before|compare/.test(loweredKey)) score += PRICE_SCORE.jsonOriginalPricePenalty;
  if (/other sellers|no featured offers available|buying options|see all buying options/.test(context)) score += PRICE_SCORE.jsonOtherSellersPenalty;
  if (/\bolpmessage\b|\boption from\b|\bfrom \$|\bfrom [a-z]{3}\b/.test(context) || /olp|option/.test(loweredKey)) score += PRICE_SCORE.jsonOptionPenalty;

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
    score += validFrom > now + 60_000 ? PRICE_SCORE.offerFuturePenalty : PRICE_SCORE.offerCurrentBonus;
  }

  if (validUntil !== null) {
    score += validUntil < now - 60_000 ? PRICE_SCORE.offerExpiredPenalty : PRICE_SCORE.offerValidUntilBonus;
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
    if (loweredCandidateName === loweredProductName) score += PRICE_SCORE.nameExactMatch;
    else if (loweredCandidateName.includes(loweredProductName) || loweredProductName.includes(loweredCandidateName)) score += PRICE_SCORE.namePartialMatch;
    else score += PRICE_SCORE.nameMismatchPenalty;
  }

  if (/base game/.test(offerContext)) score += PRICE_SCORE.structuredBaseGameBonus;
  if (/deluxe|upgrade|add-on|addon|dlc|bundle|edition/.test(loweredCandidateName) || /deluxe|upgrade|add-on|addon|dlc|bundle|edition/.test(offerContext)) score += PRICE_SCORE.structuredEditionPenalty;
  if (/sale|discount|promo|promotion|special offer|deal/.test(offerContext)) score += PRICE_SCORE.structuredDiscountPenalty;
  if (/scheduled|upcoming|future|prepurchase|pre-order|preorder|coming soon/.test(offerContext)) score += PRICE_SCORE.structuredFuturePenalty;
  if (/in stock|instock|available|active/.test(offerContext)) score += PRICE_SCORE.structuredAvailabilityBonus;
  if (/outofstock|out of stock|unavailable|expired/.test(offerContext)) score += PRICE_SCORE.structuredUnavailablePenalty;
  if (!Number.isFinite(numericValue) || numericValue <= 0) score += PRICE_SCORE.invalidNumericPenalty;

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
        let score = PRICE_SCORE.genericSelectorBase - index;
        const loweredSelector = selector.toLowerCase();
        const loweredRaw = raw.toLowerCase();
        if (loweredSelector.includes("product")) score += PRICE_SCORE.genericSelectorProductBonus;
        if (loweredSelector.includes("data-testid")) score += PRICE_SCORE.genericSelectorTestIdBonus;
        if (attribute === "data-price") score += PRICE_SCORE.genericSelectorDataPriceBonus;
        if (node.parents("script,noscript,style").length > 0) score += PRICE_SCORE.genericSelectorHiddenPenalty;
        if (/wishlist|discount|save|xp|rating|reviews|star/.test(loweredRaw)) score += PRICE_SCORE.genericSelectorNoisePenalty;
        if (/\bwas\b|previously|before/.test(loweredRaw)) score += PRICE_SCORE.genericSelectorWasPricePenalty;
        if (/\bnow\b|current price|club price|special/.test(loweredRaw)) score += PRICE_SCORE.genericSelectorCurrentPriceBonus;
        if (/other sellers|buying options|option from|from \$|from [a-z]{3}\b/.test(loweredRaw)) score += PRICE_SCORE.genericSelectorOptionPenalty;
        if (/no featured offers available/.test(pageHtml.toLowerCase())) score += PRICE_SCORE.genericSelectorNoOffersPenalty;
        if (node.text().trim().length <= 18) score += PRICE_SCORE.genericSelectorCompactTextBonus;
        const hasInclusiveTaxLabel = /(?:inc|incl)\.?\s*(?:gst|vat|tax)\b|(?:including|with)\s+tax\b|tax\s*included\b|\bttc\b|\btva\s*incl(?:use)?\b/.test(loweredRaw);
        const hasExclusiveTaxLabel = /\+gst\b|ex\s*gst\b|excluding\s*gst\b|\+vat\b|ex\s*vat\b|excluding\s*vat\b|ex\s*tax\b|excluding\s*tax\b|tax\s*excluded\b/.test(loweredRaw);
        if (hasInclusiveTaxLabel) score += PRICE_SCORE.inclusiveTaxBonus;
        if (hasExclusiveTaxLabel && !hasInclusiveTaxLabel) score += PRICE_SCORE.exclusiveTaxPenalty;

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
      score: PRICE_SCORE.purchaseTextPattern
    },
    {
      regex: /((?:NZ\$|A\$|AU\$|US\$|\$|€|£)\s*[0-9]+(?:\.[0-9]{2})?)/gi,
      source: "auto:inline-currency-price",
      score: PRICE_SCORE.inlineCurrencyPattern
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
      if (!key || !value || !isPlausiblePriceText(value)) {
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
  availability?: AvailabilityStatus | null;
  detectionSource: string;
  previewRawText: string;
  previewPrice: string;
}): DetectionResult {
  return {
    name: input.name,
    pageTitle: input.pageTitle,
    url: input.url,
    currency: input.currency ?? "",
    availability: input.availability ?? null,
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

function detectSpecificProductName(_finalUrl: string, _html: string, $: cheerio.CheerioAPI, fallbackName: string): string {
  return $("meta[property='og:title']").attr("content")?.trim()
    || $("h1").first().text().trim()
    || fallbackName;
}

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

function normalizeAvailabilityValue(value: string): AvailabilityStatus | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (
    /instock|in stock|limitedavailability|limited availability|onlineonly|online only|preorder|pre-order|presale|pre-sale|backorder|back-order/.test(normalized)
  ) {
    return "available";
  }

  if (
    /outofstock|out of stock|soldout|sold out|unavailable|discontinued|instoreonly|in store only/.test(normalized)
  ) {
    return "unavailable";
  }

  return null;
}

function detectAvailabilityFromSchema(html: string): AvailabilityStatus | null {
  const matches = html.matchAll(/"availability"\s*:\s*"([^"]+)"/gi);
  for (const match of matches) {
    const availability = normalizeAvailabilityValue(match[1] ?? "");
    if (availability) {
      return availability;
    }
  }

  return null;
}

function detectAvailabilityFromJsonSignals(html: string): AvailabilityStatus | null {
  const unavailablePatterns = [
    /"(?:isBuyable|buyable|availableForDelivery|availableForPickup|inStock)"\s*:\s*false/gi,
    /"(?:stockState|stock_status|availabilityStatus)"\s*:\s*"(?:outofstock|out of stock|soldout|sold out|unavailable|instoreonly|in store only)"/gi
  ];
  for (const pattern of unavailablePatterns) {
    if (pattern.test(html)) {
      return "unavailable";
    }
  }

  const availablePatterns = [
    /"(?:isBuyable|buyable|availableForDelivery|availableForPickup|inStock)"\s*:\s*true/gi,
    /"(?:stockState|stock_status|availabilityStatus)"\s*:\s*"(?:instock|in stock|available|limitedavailability|limited availability)"/gi
  ];
  for (const pattern of availablePatterns) {
    if (pattern.test(html)) {
      return "available";
    }
  }

  return null;
}

function isProbablyHiddenElement(node: cheerio.Cheerio<any>): boolean {
  const style = (node.attr("style") ?? "").toLowerCase();
  const hiddenAttr = node.attr("hidden");
  const ariaHidden = (node.attr("aria-hidden") ?? "").toLowerCase();
  const classes = (node.attr("class") ?? "").toLowerCase();

  return Boolean(
    hiddenAttr !== undefined
    || ariaHidden === "true"
    || /display\s*:\s*none|visibility\s*:\s*hidden/.test(style)
    || /\bhidden\b/.test(classes)
  );
}

function readAvailabilityCandidateText(node: cheerio.Cheerio<any>): string {
  const text = node.text().replace(/\s+/g, " ").trim();
  if (text) {
    return text;
  }

  const attributeCandidates = [
    node.attr("aria-label"),
    node.attr("alt"),
    node.attr("title"),
    node.attr("value")
  ];

  for (const candidate of attributeCandidates) {
    const normalized = (candidate ?? "").replace(/\s+/g, " ").trim();
    if (normalized) {
      return normalized;
    }
  }

  return "";
}

function collectAvailabilityTextCandidates($: cheerio.CheerioAPI): { visible: string[]; all: string[] } {
  const selectors = [
    "[data-testid*='availability']",
    "[data-test*='availability']",
    "[data-testid*='stock']",
    "[data-test*='stock']",
    "[class*='availability']",
    "[class*='stock']",
    "[id*='availability']",
    "[id*='stock']",
    "button",
    "[role='button']"
  ];
  const visibleCandidates = new Set<string>();
  const allCandidates = new Set<string>();

  for (const selector of selectors) {
    $(selector).slice(0, 24).each((_, element) => {
      const node = $(element);
      const text = readAvailabilityCandidateText(node);
      if (text) {
        allCandidates.add(text);
        if (!isProbablyHiddenElement(node)) {
          visibleCandidates.add(text);
        }
      }
    });
  }

  return {
    visible: [...visibleCandidates],
    all: [...allCandidates]
  };
}

function detectAvailabilityFromText($: cheerio.CheerioAPI): AvailabilityStatus | null {
  const { visible, all } = collectAvailabilityTextCandidates($);

  const detectFromCandidates = (textCandidates: string[], preferAvailable = false): AvailabilityStatus | null => {
    let sawUnavailable = false;
    let sawAvailable = false;

    for (const candidate of textCandidates) {
      const normalized = candidate.toLowerCase();
      if (
        /\b(out of stock|sold out|currently unavailable|not available online|temporarily unavailable|unavailable online|in store only)\b/.test(normalized)
      ) {
        sawUnavailable = true;
      }
      if (
        /\b(in stock|available now|available online|add to cart|add to bag|buy now|order now)\b/.test(normalized)
      ) {
        sawAvailable = true;
      }
    }

    if (preferAvailable && sawAvailable) {
      return "available";
    }
    if (sawUnavailable) {
      return "unavailable";
    }
    if (sawAvailable) {
      return "available";
    }
    return null;
  };

  const visibleResult = detectFromCandidates(visible, true);
  if (visibleResult) {
    return visibleResult;
  }

  return detectFromCandidates(all);
}

export function detectAvailabilityFromHtml(finalUrl: string, html: string): AvailabilityStatus | null {
  buildDetectionContext(finalUrl, html);
  const $ = cheerio.load(html);

  return detectAvailabilityFromSchema(html)
    ?? detectAvailabilityFromJsonSignals(html)
    ?? detectAvailabilityFromText($)
    ?? null;
}

function collectDetectionCandidates(
  context: HtmlDetectionContext,
  html: string
): DetectionCandidate[] {
  const $ = cheerio.load(html);
  const availability = detectAvailabilityFromSchema(html)
    ?? detectAvailabilityFromJsonSignals(html)
    ?? detectAvailabilityFromText($);
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
        availability,
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
        availability,
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
        availability,
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

  if (jsonLdResult) return jsonLdResult;
  if (genericResult) return genericResult;
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
              let score = PRICE_SCORE.jsonLdBase;
              if ((typeof price === "string" || typeof price === "number") && `${rawCandidate}` === `${price}`) {
                score += PRICE_SCORE.jsonLdPrimaryPriceBonus;
              }
              if ((typeof lowPrice === "string" || typeof lowPrice === "number") && `${rawCandidate}` === `${lowPrice}`) {
                score += PRICE_SCORE.jsonLdLowPriceBonus;
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
  const payloadPattern = /<script[^>]+data-pricebuzz-capture[^>]*>([\s\S]*?)<\/script>/gi;
  type Candidate = { previewRawText: string; previewPrice: string; currency: string; score: number };
  const candidates: Candidate[] = [];

  for (const match of html.matchAll(payloadPattern)) {
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
        const score = PRICE_SCORE.capturedOfferBase + scoreStructuredOfferContext(
          productName,
          offerName,
          offer,
          extracted.previewPrice
        );
        candidates.push({
          previewRawText: extracted.previewRawText,
          previewPrice: extracted.previewPrice,
          currency: extracted.currency,
          score
        });
      }
    } catch {
      // Ignore malformed captured payloads.
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

export function detectTrackedItemFromHtml(finalUrl: string, html: string): DetectionResult {
  const context = buildDetectionContext(finalUrl, html);
  const candidates = collectDetectionCandidates(context, html);
  const winner = chooseBestDetectionCandidate(candidates, context.pageCurrency);
  if (winner) {
    return winner;
  }

  throw new Error("Could not automatically detect a price on this page yet.");
}

export function extractTrackedItemCheckDataFromHtml(
  item: TrackedItemRecord,
  html: string
): {
  rawText: string;
  price: string;
  currency: string | null;
  availability: AvailabilityStatus | null;
} {
  const detection = detectTrackedItemFromHtml(item.url, html);
  return {
    rawText: detection.previewRawText,
    price: detection.previewPrice,
    currency: detection.currency || item.currency || null,
    availability: detection.availability
  };
}
