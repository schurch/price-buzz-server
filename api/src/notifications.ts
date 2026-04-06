import type { AppDb } from "./db.js";
import type { NotificationChannelRecord, TrackedItemRecord } from "./types.js";
import { escapeHtml } from "./utils.js";

type NotificationConfig = {
  resendApiKey: string;
  resendFromEmail: string;
  telegramBotToken: string;
  telegramBotUsername: string;
};

export class NotificationService {
  private telegramUpdateOffset = 0;
  private cachedTelegramBotUsername: string | null = null;

  constructor(private readonly config: NotificationConfig) {}

  async sendPriceDrop(input: {
    channel: NotificationChannelRecord;
    item: TrackedItemRecord;
    previousPrice: string;
    newPrice: string;
    currency: string;
  }): Promise<void> {
    const message = [
      `Price dropped: ${input.item.name}`,
      `Was: ${input.currency} ${input.previousPrice}`,
      `Now: ${input.currency} ${input.newPrice}`,
      input.item.url
    ].join("\n");

    if (input.channel.type === "email") {
      await this.sendEmail(input.channel.target, "Price Drop Alert", message);
      return;
    }

    if (input.channel.type === "telegram") {
      await this.sendTelegram(input.channel.target, message);
      return;
    }

    throw new Error(`Unsupported notification channel: ${input.channel.type}`);
  }

  async sendBackInStock(input: {
    channel: NotificationChannelRecord;
    item: TrackedItemRecord;
    price: string | null;
    currency: string | null;
  }): Promise<void> {
    const lines = [
      `Back in stock: ${input.item.name}`
    ];

    if (input.price) {
      lines.push(`Current price: ${input.currency ?? input.item.currency} ${input.price}`);
    }

    lines.push(input.item.url);
    const message = lines.join("\n");

    if (input.channel.type === "email") {
      await this.sendEmail(input.channel.target, "Back In Stock Alert", message);
      return;
    }

    if (input.channel.type === "telegram") {
      await this.sendTelegram(input.channel.target, message);
      return;
    }

    throw new Error(`Unsupported notification channel: ${input.channel.type}`);
  }

  async sendEmailVerification(to: string, confirmUrl: string): Promise<void> {
    const message = [
      "Confirm this email address for price-drop alerts.",
      "",
      confirmUrl,
      "",
      "If you did not expect this, you can ignore this email."
    ].join("\n");

    await this.sendEmail(to, "Confirm price-drop alerts", message);
  }

  async sendUserEmailVerification(to: string, confirmUrl: string): Promise<void> {
    const message = [
      "Verify your PriceBuzz account email.",
      "",
      "Once verified, this address becomes your default recipient for price alerts.",
      "",
      confirmUrl,
      "",
      "If you did not create this account, you can ignore this email."
    ].join("\n");

    await this.sendEmail(to, "Verify your PriceBuzz email", message);
  }

  async sendTestEmail(to: string): Promise<void> {
    const message = [
      "PriceBuzz test email",
      "",
      `Sent at: ${new Date().toISOString()}`,
      "Your Resend notification path is working."
    ].join("\n");

    await this.sendEmail(to, "PriceBuzz test email", message);
  }

  async sendTestTelegram(chatId: string): Promise<void> {
    const message = [
      "PriceBuzz test message",
      `Sent at: ${new Date().toISOString()}`,
      "Your Telegram notification path is working."
    ].join("\n");

    await this.sendTelegram(chatId, message);
  }

  private async sendEmail(to: string, subject: string, text: string): Promise<void> {
    if (!this.config.resendApiKey || !this.config.resendFromEmail) {
      throw new Error("Resend is not configured.");
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.resendApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: this.config.resendFromEmail,
        to,
        subject,
        html: `<pre style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap;">${escapeHtml(text)}</pre>`
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Resend send failed: ${response.status} ${body}`);
    }
  }

  private async sendTelegram(chatId: string, text: string): Promise<void> {
    if (!this.config.telegramBotToken) {
      throw new Error("Telegram bot token is not configured.");
    }

    const response = await fetch(`https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram send failed: ${response.status} ${body}`);
    }
  }

  async getTelegramBotUsername(): Promise<string | null> {
    if (!this.config.telegramBotToken) {
      return null;
    }

    if (this.config.telegramBotUsername) {
      return this.config.telegramBotUsername;
    }

    if (this.cachedTelegramBotUsername) {
      return this.cachedTelegramBotUsername;
    }

    const response = await fetch(`https://api.telegram.org/bot${this.config.telegramBotToken}/getMe`);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram getMe failed: ${response.status} ${body}`);
    }

    const payload = await response.json() as { ok?: boolean; result?: { username?: string } };
    const username = payload.result?.username?.trim() ?? "";
    this.cachedTelegramBotUsername = username || null;
    return this.cachedTelegramBotUsername;
  }

  async syncTelegramLinks(db: AppDb): Promise<number> {
    if (!this.config.telegramBotToken) {
      return 0;
    }

    const response = await fetch(`https://api.telegram.org/bot${this.config.telegramBotToken}/getUpdates`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        offset: this.telegramUpdateOffset,
        timeout: 0,
        allowed_updates: ["message"]
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram getUpdates failed: ${response.status} ${body}`);
    }

    const payload = await response.json() as {
      ok?: boolean;
      result?: Array<{
        update_id: number;
        message?: {
          text?: string;
          chat?: {
            id: number | string;
            username?: string;
            first_name?: string;
            last_name?: string;
            title?: string;
          };
        };
      }>;
    };

    let linkedCount = 0;
    for (const update of payload.result ?? []) {
      this.telegramUpdateOffset = Math.max(this.telegramUpdateOffset, update.update_id + 1);
      const text = update.message?.text?.trim() ?? "";
      const chat = update.message?.chat;
      const match = text.match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]+)$/);
      if (!match || !chat) {
        continue;
      }

      const displayName = [
        chat.title,
        [chat.first_name, chat.last_name].filter(Boolean).join(" ").trim(),
        chat.username ? `@${chat.username}` : ""
      ].find((value) => value && value.trim()) ?? null;

      const linkedChannelId = db.consumeTelegramLinkToken(match[1], String(chat.id), displayName);
      if (linkedChannelId) {
        linkedCount += 1;
      }
    }

    return linkedCount;
  }
}
