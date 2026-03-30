import type { AppDb } from "./db.js";
import { NotificationService } from "./notifications.js";
import { fetchTrackedItemCheck } from "./scraper.js";

export class TrackerService {
  private running = false;
  private lastRunAt: string | null = null;

  constructor(
    private readonly db: AppDb,
    private readonly notifications: NotificationService
  ) {}

  getStatus(): { running: boolean; lastRunAt: string | null } {
    return {
      running: this.running,
      lastRunAt: this.lastRunAt
    };
  }

  async runAllChecks(): Promise<{ checked: number }> {
    if (this.running) {
      return { checked: 0 };
    }

    this.running = true;
    try {
      const items = this.db.listEnabledTrackedItems();
      await this.runChecksForItems(items);

      this.lastRunAt = new Date().toISOString();
      return { checked: items.length };
    } finally {
      this.running = false;
    }
  }

  async runChecksForUser(userId: number): Promise<{ checked: number }> {
    if (this.running) {
      return { checked: 0 };
    }

    this.running = true;
    try {
      const items = this.db
        .listTrackedItemsForUser(userId)
        .filter((item) => item.enabled && !item.archivedAt);
      await this.runChecksForItems(items);

      this.lastRunAt = new Date().toISOString();
      return { checked: items.length };
    } finally {
      this.running = false;
    }
  }

  private async runChecksForItems(items: ReturnType<AppDb["listEnabledTrackedItems"]>): Promise<void> {
    for (const item of items) {
      const previous = this.db.getLatestSuccessfulCheck(item.id);
      const owner = this.db.getUserById(item.ownerUserId);
      const result = await fetchTrackedItemCheck(item, owner ? {
        acceptLanguage: owner.acceptLanguage,
        browserLocale: owner.browserLocale,
        browserTimezone: owner.browserTimezone
      } : null);
      this.db.insertPriceCheck({
        trackedItemId: item.id,
        status: result.status,
        checkedAt: result.checkedAt,
        price: result.price,
        currency: result.currency,
        rawText: result.rawText,
        errorMessage: result.errorMessage
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
    }
  }
}
