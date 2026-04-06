import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { AppDb } from "../src/db.ts";
import { TrackerService } from "../src/tracker.ts";

function makeTempDbPath(name: string): string {
  const dir = path.join("/tmp", `pricebuzz-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.db`);
}

test("tracker sends a back-in-stock notification when availability flips to available", async () => {
  const databasePath = makeTempDbPath("tracker-back-in-stock");

  try {
    const db = new AppDb(databasePath);
    const userId = db.createUser({
      firstName: "Test",
      lastName: "User",
      email: "test@example.com",
      passwordHash: "hash",
      emailVerifiedAt: new Date().toISOString()
    });

    const trackedItemId = db.createTrackedItem({
      ownerUserId: userId,
      name: "BRIMNES Bed",
      url: "https://www.ikea.com/nz/en/p/brimnes-bed-frame-w-storage-and-headboard-white-luroey-s19157454/",
      currency: "NZD",
      initialDetectedAvailability: "unavailable",
      initialDetectedPrice: "699.00",
      initialDetectedCurrency: "NZD",
      initialDetectedRawText: "699"
    });

    const channelId = db.createNotificationChannel(
      userId,
      "email",
      "alerts@example.com",
      "Alerts",
      new Date().toISOString()
    );

    const sent: Array<{ type: string; target: string }> = [];
    const notifications = {
      async sendBackInStock(input: { channel: { target: string } }) {
        sent.push({ type: "back_in_stock", target: input.channel.target });
      },
      async sendPriceDrop() {
        sent.push({ type: "price_drop", target: "unexpected" });
      }
    } as any;

    const tracker = new TrackerService(
      db,
      notifications,
      async () => ({
        status: "ok" as const,
        checkedAt: new Date().toISOString(),
        availability: "available" as const,
        price: "699.00",
        currency: "NZD",
        rawText: "699"
      })
    );

    const summary = await tracker.runChecksForUser(userId);

    assert.equal(summary.checked, 1);
    assert.equal(summary.successes, 1);
    assert.equal(summary.errors, 0);
    assert.deepEqual(sent, [{ type: "back_in_stock", target: "alerts@example.com" }]);

    const recentChecks = db.getRecentChecks(trackedItemId, 2);
    assert.equal(recentChecks[0]?.availability, "available");
    assert.equal(recentChecks[1]?.availability, "unavailable");

    const deliveries = db.listAlertDeliveriesForTrackedItem(trackedItemId);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.channelId, channelId);
    assert.equal(deliveries[0]?.eventType, "back_in_stock");
    assert.equal(deliveries[0]?.status, "sent");
  } finally {
    rmSync(path.dirname(databasePath), { recursive: true, force: true });
  }
});

test("tracker sends a price-drop notification when the latest price is lower", async () => {
  const databasePath = makeTempDbPath("tracker-price-drop");

  try {
    const db = new AppDb(databasePath);
    const userId = db.createUser({
      firstName: "Test",
      lastName: "User",
      email: "test@example.com",
      passwordHash: "hash",
      emailVerifiedAt: new Date().toISOString()
    });

    const trackedItemId = db.createTrackedItem({
      ownerUserId: userId,
      name: "Ninja Air Fryer",
      url: "https://ninjakitchen.co.nz/products/ninja-air-fryer-4-7l-pro",
      currency: "NZD",
      initialDetectedAvailability: "available",
      initialDetectedPrice: "199.00",
      initialDetectedCurrency: "NZD",
      initialDetectedRawText: "199"
    });

    const channelId = db.createNotificationChannel(
      userId,
      "email",
      "alerts@example.com",
      "Alerts",
      new Date().toISOString()
    );

    const sent: Array<{ type: string; target: string; previousPrice?: string; newPrice?: string }> = [];
    const notifications = {
      async sendBackInStock() {
        sent.push({ type: "back_in_stock", target: "unexpected" });
      },
      async sendPriceDrop(input: { channel: { target: string }; previousPrice: string; newPrice: string }) {
        sent.push({
          type: "price_drop",
          target: input.channel.target,
          previousPrice: input.previousPrice,
          newPrice: input.newPrice
        });
      }
    } as any;

    const tracker = new TrackerService(
      db,
      notifications,
      async () => ({
        status: "ok" as const,
        checkedAt: new Date().toISOString(),
        availability: "available" as const,
        price: "149.00",
        currency: "NZD",
        rawText: "149"
      })
    );

    const summary = await tracker.runChecksForUser(userId);

    assert.equal(summary.checked, 1);
    assert.equal(summary.successes, 1);
    assert.equal(summary.errors, 0);
    assert.deepEqual(sent, [{
      type: "price_drop",
      target: "alerts@example.com",
      previousPrice: "199.00",
      newPrice: "149.00"
    }]);

    const recentChecks = db.getRecentChecks(trackedItemId, 2);
    assert.equal(recentChecks[0]?.price, "149.00");
    assert.equal(recentChecks[0]?.availability, "available");
    assert.equal(recentChecks[1]?.price, "199.00");

    const deliveries = db.listAlertDeliveriesForTrackedItem(trackedItemId);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.channelId, channelId);
    assert.equal(deliveries[0]?.eventType, "price_drop");
    assert.equal(deliveries[0]?.status, "sent");
  } finally {
    rmSync(path.dirname(databasePath), { recursive: true, force: true });
  }
});
