import path from "node:path";

function integerFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: integerFromEnv("PORT", 4321),
  appBaseUrl: (process.env.APP_BASE_URL ?? "").trim().replace(/\/+$/, ""),
  databasePath: path.resolve(process.env.DATABASE_PATH ?? "./data/app.db"),
  checkIntervalMinutes: integerFromEnv("CHECK_INTERVAL_MINUTES", 360),
  timeoutSeconds: integerFromEnv("PRICE_TRACKER_TIMEOUT", 20),
  userAgent:
    process.env.PRICE_TRACKER_USER_AGENT ??
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  sessionCookieName: "pricebuzz_session",
  bootstrapAdminEmail: (process.env.BOOTSTRAP_ADMIN_EMAIL ?? "").trim().toLowerCase(),
  bootstrapAdminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "",
  resendApiKey: (process.env.RESEND_API_KEY ?? "").trim(),
  resendFromEmail: (process.env.RESEND_FROM_EMAIL ?? "").trim(),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramBotUsername: (process.env.TELEGRAM_BOT_USERNAME ?? "").trim().replace(/^@/, "")
};
