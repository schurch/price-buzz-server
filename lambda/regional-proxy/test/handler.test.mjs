import test from "node:test";
import assert from "node:assert/strict";

import { authorize, extractTitle, looksBlocked, parseProxyRequest } from "../index.mjs";

test("parseProxyRequest accepts body url and defaults mode to http", () => {
  const result = parseProxyRequest({
    body: JSON.stringify({
      url: "https://example.com/product"
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.url, "https://example.com/product");
  assert.equal(result.mode, "http");
});

test("parseProxyRequest rejects invalid mode", () => {
  const result = parseProxyRequest({
    body: JSON.stringify({
      url: "https://example.com/product",
      mode: "weird"
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 400);
});

test("looksBlocked detects cloudflare challenge pages", () => {
  const blocked = looksBlocked(
    "Just a moment...",
    "<html><body>Enable JavaScript and cookies to continue /cdn-cgi/challenge-platform/</body></html>"
  );

  assert.equal(blocked, true);
});

test("extractTitle returns page title", () => {
  assert.equal(extractTitle("<html><head><title>Example Product</title></head></html>"), "Example Product");
});

test("authorize passes without configured secret", () => {
  delete process.env.PROXY_SHARED_SECRET;
  assert.equal(authorize({}), true);
});

test("authorize checks configured secret", () => {
  process.env.PROXY_SHARED_SECRET = "top-secret";
  assert.equal(authorize({ headers: { "x-proxy-secret": "top-secret" } }), true);
  assert.equal(authorize({ headers: { "x-proxy-secret": "wrong" } }), false);
  delete process.env.PROXY_SHARED_SECRET;
});
