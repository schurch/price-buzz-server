import type { AppDb } from "./db.js";
import { NotificationService } from "./notifications.js";
import { fetchTrackedItemCheck } from "./scraper.js";
import type { ScrapePreferences, TrackedItemRecord } from "./types.js";

type CheckFetcher = (
  item: TrackedItemRecord,
  scrapePreferences: ScrapePreferences | null
) => ReturnType<typeof fetchTrackedItemCheck>;

export class TrackerService {
  private running = false;
  private lastRunAt: string | null = null;

  constructor(
    private readonly db: AppDb,
    private readonly notifications: NotificationService,
    private readonly fetchCheck: CheckFetcher = fetchTrackedItemCheck
  ) {}

  getStatus(): { running: boolean; lastRunAt: string | null } {
    return {
      running: this.running,
      lastRunAt: this.lastRunAt
    };
  }

  async runAllChecks(): Promise<{
    checked: number;
    successes: number;
    errors: number;
    items: Array<{
      trackedItemId: number;
      name: string;
      url: string;
      status: "ok" | "error";
      checkedAt: string;
      availability: "available" | "unavailable" | null;
      price: string | null;
      currency: string | null;
      errorMessage: string | null;
    }>;
  }> {
    if (this.running) {
      return { checked: 0, successes: 0, errors: 0, items: [] };
    }

    this.running = true;
    try {
      const items = this.db.listEnabledTrackedItems();
      const results = await this.runChecksForItems(items);

      this.lastRunAt = new Date().toISOString();
      return {
        checked: items.length,
        successes: results.filter((entry) => entry.status === "ok").length,
        errors: results.filter((entry) => entry.status === "error").length,
        items: results
      };
    } finally {
      this.running = false;
    }
  }

  async runChecksForUser(userId: number): Promise<{
    checked: number;
    successes: number;
    errors: number;
    items: Array<{
      trackedItemId: number;
      name: string;
      url: string;
      status: "ok" | "error";
      checkedAt: string;
      availability: "available" | "unavailable" | null;
      price: string | null;
      currency: string | null;
      errorMessage: string | null;
    }>;
  }> {
    if (this.running) {
      return { checked: 0, successes: 0, errors: 0, items: [] };
    }

    this.running = true;
    try {
      const items = this.db
        .listTrackedItemsForUser(userId)
        .filter((item) => item.enabled && !item.archivedAt);
      const results = await this.runChecksForItems(items);

      this.lastRunAt = new Date().toISOString();
      return {
        checked: items.length,
        successes: results.filter((entry) => entry.status === "ok").length,
        errors: results.filter((entry) => entry.status === "error").length,
        items: results
      };
    } finally {
      this.running = false;
    }
  }

  private async runChecksForItems(items: ReturnType<AppDb["listEnabledTrackedItems"]>): Promise<Array<{
    trackedItemId: number;
    name: string;
    url: string;
    status: "ok" | "error";
    checkedAt: string;
    availability: "available" | "unavailable" | null;
    price: string | null;
    currency: string | null;
    errorMessage: string | null;
  }>> {
    const runResults: Array<{
      trackedItemId: number;
      name: string;
      url: string;
      status: "ok" | "error";
      checkedAt: string;
      availability: "available" | "unavailable" | null;
      price: string | null;
      currency: string | null;
      errorMessage: string | null;
    }> = [];

    for (const item of items) {
      const previous = this.db.getLatestSuccessfulCheck(item.id);
      const owner = this.db.getUserById(item.ownerUserId);
      const result = await this.fetchCheck(item, {
        acceptLanguage: item.acceptLanguage ?? owner?.acceptLanguage ?? null,
        browserLocale: item.browserLocale ?? owner?.browserLocale ?? null,
        browserTimezone: item.browserTimezone ?? owner?.browserTimezone ?? null
      });
      this.db.insertPriceCheck({
        trackedItemId: item.id,
        status: result.status,
        checkedAt: result.checkedAt,
        availability: result.availability,
        price: result.price,
        currency: result.currency,
        rawText: result.rawText,
        errorMessage: result.errorMessage
      });
      runResults.push({
        trackedItemId: item.id,
        name: item.name,
        url: item.url,
        status: result.status,
        checkedAt: result.checkedAt,
        availability: result.availability ?? null,
        price: result.price ?? null,
        currency: result.currency ?? item.currency,
        errorMessage: result.errorMessage ?? null
      });

      if (
        previous?.price &&
        result.status === "ok" &&
        result.price &&
        Number.parseFloat(result.price) < Number.parseFloat(previous.price)
      ) {
        const channels = this.db
          .listNotificationChannelsForUser(item.ownerUserId)
          .filter((channel) => channel.enabled)
          .filter((channel) => channel.type !== "email" || Boolean(channel.verifiedAt));
        for (const channel of channels) {
          try {
            await this.notifications.sendPriceDrop({
              channel,
              item,
              previousPrice: previous.price,
              newPrice: result.price,
              currency: result.currency ?? item.currency
            });
            this.db.insertAlertDelivery({
              trackedItemId: item.id,
              channelId: channel.id,
              eventType: "price_drop",
              status: "sent",
              detail: channel.target
            });
          } catch (error) {
            this.db.insertAlertDelivery({
              trackedItemId: item.id,
              channelId: channel.id,
              eventType: "price_drop",
              status: "failed",
              detail: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }

      if (
        previous?.availability === "unavailable"
        && result.status === "ok"
        && result.availability === "available"
      ) {
        const channels = this.db
          .listNotificationChannelsForUser(item.ownerUserId)
          .filter((channel) => channel.enabled)
          .filter((channel) => channel.type !== "email" || Boolean(channel.verifiedAt));
        for (const channel of channels) {
          try {
            await this.notifications.sendBackInStock({
              channel,
              item,
              price: result.price ?? null,
              currency: result.currency ?? item.currency
            });
            this.db.insertAlertDelivery({
              trackedItemId: item.id,
              channelId: channel.id,
              eventType: "back_in_stock",
              status: "sent",
              detail: channel.target
            });
          } catch (error) {
            this.db.insertAlertDelivery({
              trackedItemId: item.id,
              channelId: channel.id,
              eventType: "back_in_stock",
              status: "failed",
              detail: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }
    }

    return runResults;
  }
}
