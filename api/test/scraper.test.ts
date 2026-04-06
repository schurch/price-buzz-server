import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { shouldUseBrowserFallbackForHtml } from "../src/scraper/blocking.ts";
import {
  detectTrackedItemFromHtml,
  extractTrackedItemCheckDataFromHtml,
  fetchHtmlViaRegionalProxy,
  resolveRegionalFallbackRegion,
  shouldRetryWithNzRegionalFallback,
  validateScrapeUrl
} from "../src/scraper.ts";
import { config } from "../src/config.ts";
import type { TrackedItemRecord } from "../src/types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, "fixtures");

function loadFixture(name: string): string {
  return readFileSync(path.join(fixturesDir, name), "utf8");
}

function detectFromFixture(url: string, fixtureName: string) {
  return detectTrackedItemFromHtml(url, loadFixture(fixtureName));
}

test("empty JS app shells trigger browser fallback", () => {
  const html = `
    <html>
      <head>
        <title>Ninja Pro Air Fryer 4.7 Litre AF141WHANZ | Briscoes</title>
        <script defer src="/vendors.js"></script>
        <script defer src="/client.js"></script>
        <script defer src="/gallery.js"></script>
        <script defer src="/product.js"></script>
        <script defer src="/chunk.js"></script>
      </head>
      <body>
        <div id="root"></div>
        <noscript>Oops! JavaScript is disabled</noscript>
      </body>
    </html>
  `;

  assert.equal(
    shouldUseBrowserFallbackForHtml(
      "https://www.briscoes.co.nz/product/1121994/ninja-pro-air-fryer-4-7-litre-af141whanz/",
      html,
      "https://www.briscoes.co.nz/product/1121994/ninja-pro-air-fryer-4-7-litre-af141whanz/"
    ),
    true
  );
});

test("embedded product price signals still suppress browser fallback", () => {
  const html = `
    <html>
      <head>
        <title>Product</title>
        <meta property="product:price:amount" content="169.00">
        <meta property="product:price:currency" content="NZD">
        <script defer src="/vendors.js"></script>
        <script defer src="/client.js"></script>
        <script defer src="/gallery.js"></script>
        <script defer src="/product.js"></script>
        <script defer src="/chunk.js"></script>
      </head>
      <body>
        <div id="root"></div>
      </body>
    </html>
  `;

  assert.equal(
    shouldUseBrowserFallbackForHtml(
      "https://example.com/product/123",
      html,
      "https://example.com/product/123"
    ),
    false
  );
});

test("The Warehouse fixture resolves the NZD product price", () => {
  const result = detectFromFixture(
    "https://www.thewarehouse.co.nz/p/ps5-digital-edition-console-825gb/R3035019.html",
    "thewarehouse-ps5.html"
  );

  assert.equal(result.previewPrice, "798.00");
  assert.equal(result.currency, "NZD");
  assert.match(result.name, /PS5 Digital Edition Console 825GB/i);
});

test("YesStyle fixture prefers the displayed NZD price over stale JSON-LD USD", () => {
  const result = detectFromFixture(
    "https://www.yesstyle.com/en/tcuc.NZD/coc.NZ/info.html/pid.1134237520?googtrans=en",
    "yesstyle-1134237520.html"
  );

  assert.equal(result.previewPrice, "11.56");
  assert.equal(result.currency, "NZD");
  assert.notEqual(result.detectionSource, "auto:json-ld-price");
});

test("Epic fixture resolves the current base-game NZD price", () => {
  const result = detectFromFixture(
    "https://store.epicgames.com/en-US/p/alan-wake-2",
    "epic-alan-wake-2.html"
  );

  assert.equal(result.previewPrice, "23.98");
  assert.equal(result.currency, "NZD");
  assert.equal(result.detectionSource, "auto:captured-offer-price");
  assert.notEqual(result.previewPrice, "5.00");
});

test("Epic-style integer JSON prices are normalized using currency decimals", () => {
  const html = `
    <html>
      <head><title>Alan Wake 2</title></head>
      <body>
        <script>
          window.__PRICE__ = {
            "price": {
              "totalPrice": {
                "discountPrice": 2094,
                "originalPrice": 6998,
                "currencyCode": "SGD",
                "currencyInfo": { "decimals": 2 },
                "fmtPrice": {
                  "originalPrice": "S$69.98",
                  "discountPrice": "S$20.94"
                }
              }
            },
            "offerType": "BASE_GAME"
          };
        </script>
      </body>
    </html>
  `;

  const result = detectTrackedItemFromHtml(
    "https://store.epicgames.com/en-US/p/alan-wake-2",
    html
  );

  assert.equal(result.previewPrice, "20.94");
  assert.equal(result.currency, "SGD");
  assert.equal(result.detectionSource, "auto:json-price-key");
});

test("Amazon fixture keeps AUD and does not misread UTF as a currency", () => {
  const result = detectFromFixture(
    "https://www.amazon.com.au/Keychron-Bluetooth-Wireless-Mechanical-Hot-Swappable/dp/B0874HX6K2/",
    "amazon-keychron-k2v2.html"
  );

  assert.equal(result.previewPrice, "129.00");
  assert.equal(result.currency, "AUD");
  assert.notEqual(result.currency, "UTF");
});

test("Farmers fixture resolves the NZD product price", () => {
  const result = detectFromFixture(
    "https://www.farmers.co.nz/home/bedding/bed-sheets-pillowcases/haven-flannelette-print-sheet-set-range-7002806A",
    "farmers-7002806A.html"
  );

  assert.equal(result.previewPrice, "89.00");
  assert.equal(result.currency, "NZD");
});

test("New World fixture resolves the NZD product price", () => {
  const result = detectFromFixture(
    "https://www.newworld.co.nz/shop/product/5105651_kgm_000nw?name=skinless-chicken-breast",
    "newworld-5105651.html"
  );

  assert.equal(result.previewPrice, "15.49");
  assert.equal(result.currency, "NZD");
});

test("IKEA fixture resolves the NZD product price", () => {
  const result = detectFromFixture(
    "https://www.ikea.com/nz/en/p/kallax-shelving-unit-white-00616767/",
    "ikea-kallax-00616767.html"
  );

  assert.equal(result.previewPrice, "69.00");
  assert.equal(result.currency, "NZD");
  assert.match(result.name, /KALLAX/i);
});

test("Apple fixture resolves the starting NZD price", () => {
  const result = detectFromFixture(
    "https://www.apple.com/nz/shop/buy-mac/macbook-neo",
    "apple-macbook-neo.html"
  );

  assert.equal(result.previewPrice, "1149.00");
  assert.equal(result.currency, "NZD");
  assert.match(result.name, /MacBook Neo/i);
});

test("Woolworths fixture resolves the NZD product price", () => {
  const result = detectFromFixture(
    "https://www.woolworths.co.nz/shop/productdetails?stockcode=750825&name=tasti-protein-bar-muesli-bars-nutty-choc",
    "woolworths-750825.html"
  );

  assert.equal(result.previewPrice, "6.39");
  assert.equal(result.currency, "NZD");
});

test("JSON-LD tracked items do not fall back to Shopify variant cents prices", () => {
  const html = `
    <html>
      <head>
        <meta property="og:price:amount" content="169.00">
        <meta property="og:price:currency" content="NZD">
        <script>
          var meta = {"product":{"variants":[{"id":51615992021364,"price":16900}]}}
        </script>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Product",
            "name": "Keychron V1 Knob 75% RGB Carbon Black Mechanical Keyboard - K Pro Red Switch",
            "offers": {
              "@type": "Offer",
              "price": 169.0,
              "priceCurrency": "NZD"
            }
          }
        </script>
      </head>
      <body>
        <div class="price"><strong class="price__current">$169.00</strong></div>
      </body>
    </html>
  `;

  const detected = detectTrackedItemFromHtml(
    "https://computerlounge.co.nz/products/keychron-v1-rgb-75-tkl-wired-mechanical-keyboard-carbon-black-red-switch",
    html
  );
  assert.equal(detected.detectionSource, "auto:json-ld-price");
  assert.equal(detected.previewPrice, "169.00");

  const trackedItem: TrackedItemRecord = {
    id: 1,
    ownerUserId: 1,
    name: detected.name,
    pageTitle: detected.pageTitle,
    url: detected.url,
    acceptLanguage: null,
    browserLocale: null,
    browserTimezone: null,
    currency: detected.currency,
    headersJson: null,
    detectionSource: detected.detectionSource,
    initialDetectedPrice: detected.previewPrice,
    initialDetectedCurrency: detected.currency,
    initialDetectedRawText: detected.previewRawText,
    firstDetectedAt: null,
    enabled: true,
    archivedAt: null,
    createdAt: "",
    updatedAt: ""
  };

  const checked = extractTrackedItemCheckDataFromHtml(trackedItem, html);
  assert.equal(checked.rawText, "169");
  assert.equal(checked.price, "169.00");
  assert.equal(checked.currency, "NZD");
});

test("auto-detected inline currency items re-detect instead of replaying stale HTML regexes", () => {
  const html = loadFixture("yesstyle-1134237520.html");
  const detected = detectTrackedItemFromHtml(
    "https://www.yesstyle.com/en/tcuc.NZD/coc.NZ/info.html/pid.1134237520?googtrans=en",
    html
  );

  assert.equal(detected.detectionSource, "auto:inline-currency-price");
  assert.equal(detected.previewPrice, "11.56");

  const trackedItem: TrackedItemRecord = {
    id: 1,
    ownerUserId: 1,
    name: detected.name,
    pageTitle: detected.pageTitle,
    url: detected.url,
    acceptLanguage: null,
    browserLocale: null,
    browserTimezone: null,
    currency: detected.currency,
    headersJson: null,
    detectionSource: detected.detectionSource,
    initialDetectedPrice: detected.previewPrice,
    initialDetectedCurrency: detected.currency,
    initialDetectedRawText: detected.previewRawText,
    firstDetectedAt: null,
    enabled: true,
    archivedAt: null,
    createdAt: "",
    updatedAt: ""
  };

  const checked = extractTrackedItemCheckDataFromHtml(trackedItem, html);
  assert.equal(checked.rawText, "NZ$ 11.56");
  assert.equal(checked.price, "11.56");
  assert.equal(checked.currency, "NZD");
});

test("regional proxy challenge HTML is rejected even when blocked flag is false", async () => {
  const originalFetch = globalThis.fetch;
  const originalProxy = {
    ...config.regionalProxy.nz
  };
  config.regionalProxy.nz.url = "https://proxy.example.test/";
  config.regionalProxy.nz.secret = "secret";

  const challengeHtml = `
    <html>
      <head><title>One more step</title></head>
      <body>
        <p>Please complete a security check to continue</p>
        <noscript><span>Enable JavaScript and cookies to continue</span></noscript>
        <script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>
      </body>
    </html>
  `;

  try {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          mode: "http",
          finalUrl: "https://1.1.1.1/en-US/p/alan-wake-2",
          html: challengeHtml,
          blocked: false
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )) as typeof fetch;

    await assert.rejects(
      () =>
        fetchHtmlViaRegionalProxy(
          "https://1.1.1.1/en-US/p/alan-wake-2",
          "nz",
          "http"
        ),
      /challenging automated traffic/i
    );
  } finally {
    globalThis.fetch = originalFetch;
    config.regionalProxy.nz.url = originalProxy.url;
    config.regionalProxy.nz.secret = originalProxy.secret;
  }
});

test("NZD tracked items resolve NZ regional fallback even without saved scrape preferences", () => {
  assert.equal(resolveRegionalFallbackRegion(null, "NZD"), "nz");
  assert.equal(resolveRegionalFallbackRegion(
    { acceptLanguage: null, browserLocale: null, browserTimezone: "Pacific/Auckland" },
    null
  ), "nz");
  assert.equal(resolveRegionalFallbackRegion(null, "SGD"), null);
});

test("NZ users retry through NZ regional fallback when local currency is not NZD", () => {
  assert.equal(
    shouldRetryWithNzRegionalFallback(
      { acceptLanguage: "en-NZ,en;q=0.9", browserLocale: "en-NZ", browserTimezone: "Pacific/Auckland" },
      null,
      "SGD"
    ),
    true
  );
  assert.equal(
    shouldRetryWithNzRegionalFallback(
      { acceptLanguage: "en-NZ,en;q=0.9", browserLocale: "en-NZ", browserTimezone: "Pacific/Auckland" },
      null,
      "NZD"
    ),
    false
  );
  assert.equal(
    shouldRetryWithNzRegionalFallback(null, "NZD", "SGD"),
    true
  );
});

test("tracked items include item-level scrape preference persistence and lookup", () => {
  const dbSource = readFileSync(path.join(__dirname, "../src/db.ts"), "utf8");
  const serverSource = readFileSync(path.join(__dirname, "../src/server.ts"), "utf8");
  const trackerSource = readFileSync(path.join(__dirname, "../src/tracker.ts"), "utf8");

  assert.match(dbSource, /accept_language TEXT/);
  assert.match(dbSource, /browser_locale TEXT/);
  assert.match(dbSource, /browser_timezone TEXT/);
  assert.match(dbSource, /accept_language = @acceptLanguage/);
  assert.match(dbSource, /browser_locale = @browserLocale/);
  assert.match(dbSource, /browser_timezone = @browserTimezone/);
  assert.match(serverSource, /acceptLanguage: scrapePreferences\.acceptLanguage/);
  assert.match(serverSource, /browserLocale: scrapePreferences\.browserLocale/);
  assert.match(serverSource, /browserTimezone: scrapePreferences\.browserTimezone/);
  assert.match(trackerSource, /acceptLanguage: item\.acceptLanguage \?\? owner\?\.acceptLanguage \?\? null/);
  assert.match(trackerSource, /browserLocale: item\.browserLocale \?\? owner\?\.browserLocale \?\? null/);
  assert.match(trackerSource, /browserTimezone: item\.browserTimezone \?\? owner\?\.browserTimezone \?\? null/);
});

test("validateScrapeUrl rejects localhost and private network targets", async () => {
  await assert.rejects(() => validateScrapeUrl("http://127.0.0.1:8080/private"));
  await assert.rejects(() => validateScrapeUrl("http://localhost:3000/private"));
  await assert.rejects(() => validateScrapeUrl("http://169.254.169.254/latest/meta-data"));
});
