import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { detectTrackedItemFromHtml } from "../src/scraper.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, "fixtures");

function loadFixture(name: string): string {
  return readFileSync(path.join(fixturesDir, name), "utf8");
}

function detectFromFixture(url: string, fixtureName: string) {
  return detectTrackedItemFromHtml(url, loadFixture(fixtureName));
}

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
  assert.notEqual(result.previewPrice, "5.00");
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
