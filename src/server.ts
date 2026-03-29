import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import { buildSessionExpiry, createPasswordHash, createSessionToken, verifyPassword } from "./auth.js";
import { config } from "./config.js";
import { AppDb } from "./db.js";
import { NotificationService } from "./notifications.js";
import { renderAuthPage, renderLandingPage, renderOnboardingPage, renderPlatformAdminPage, renderUserAdminPage, renderUserDashboard } from "./render.js";
import { detectTrackedItem } from "./scraper.js";
import { TrackerService } from "./tracker.js";
import type { ScrapePreferences, UserRecord } from "./types.js";

const app = Fastify({ logger: true });
const db = new AppDb(config.databasePath);
const notifications = new NotificationService({
  resendApiKey: config.resendApiKey,
  resendFromEmail: config.resendFromEmail,
  telegramBotToken: config.telegramBotToken,
  telegramBotUsername: config.telegramBotUsername
});
const tracker = new TrackerService(db, notifications);

app.register(import("@fastify/formbody"));
app.register(cookie);

type Notice = { notice?: string | null; error?: string | null };

function readFlash(request: FastifyRequest): Notice {
  const notice = request.cookies.notice ?? null;
  const error = request.cookies.error ?? null;
  return { notice, error };
}

function clearFlash(reply: FastifyReply): void {
  reply.clearCookie("notice", { path: "/" });
  reply.clearCookie("error", { path: "/" });
}

function setFlash(reply: FastifyReply, input: Notice): void {
  if (input.notice) {
    reply.setCookie("notice", input.notice, { path: "/", maxAge: 20, sameSite: "lax" });
  }
  if (input.error) {
    reply.setCookie("error", input.error, { path: "/", maxAge: 20, sameSite: "lax" });
  }
}

function setSession(reply: FastifyReply, sessionId: string): void {
  reply.setCookie(config.sessionCookieName, sessionId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 60 * 60 * 24 * 30
  });
}

function clearSession(reply: FastifyReply): void {
  reply.clearCookie(config.sessionCookieName, { path: "/" });
}

function normalizeAcceptLanguage(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/\s+/g, " ") ?? "";
  return normalized || null;
}

function normalizeBrowserLocale(value: string | null | undefined, acceptLanguage: string | null): string | null {
  const candidate = value?.trim() || acceptLanguage?.split(",")[0]?.split(";")[0]?.trim() || "";
  return candidate || null;
}

function normalizeBrowserTimezone(value: string | null | undefined): string | null {
  const timezone = value?.trim() ?? "";
  if (!timezone) {
    return null;
  }

  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return timezone;
  } catch {
    return null;
  }
}

function readScrapePreferences(
  request: FastifyRequest,
  body: Record<string, string | undefined> | null = null
): ScrapePreferences {
  const rawAcceptLanguageHeader = request.headers["accept-language"];
  const headerAcceptLanguage = typeof rawAcceptLanguageHeader === "string" ? rawAcceptLanguageHeader : null;
  const acceptLanguage = normalizeAcceptLanguage(body?.acceptLanguage ?? headerAcceptLanguage);

  return {
    acceptLanguage,
    browserLocale: normalizeBrowserLocale(body?.browserLocale, acceptLanguage),
    browserTimezone: normalizeBrowserTimezone(body?.browserTimezone)
  };
}

function persistUserScrapePreferences(userId: number, scrapePreferences: ScrapePreferences): void {
  db.updateUserScrapePreferences(userId, scrapePreferences);
}

function getCurrentUser(request: FastifyRequest): UserRecord | null {
  const sessionId = request.cookies[config.sessionCookieName];
  if (!sessionId) {
    return null;
  }

  return db.getSessionUser(sessionId);
}

function requireUser(request: FastifyRequest, reply: FastifyReply): UserRecord | null {
  const user = getCurrentUser(request);
  if (!user) {
    reply.redirect("/login");
    return null;
  }
  return user;
}

function requireAdmin(request: FastifyRequest, reply: FastifyReply): UserRecord | null {
  const user = requireUser(request, reply);
  if (!user) {
    return null;
  }
  if (user.role !== "admin") {
    reply.code(403).type("text/plain").send("Admin access required.");
    return null;
  }
  return user;
}

function ensureUserEmailNotificationChannel(user: UserRecord): void {
  db.createNotificationChannel(
    user.id,
    "email",
    user.email,
    `${user.firstName} ${user.lastName}`.trim() || null,
    user.emailVerifiedAt
  );
}

async function sendAccountEmailVerification(user: UserRecord): Promise<boolean> {
  if (!config.resendApiKey || !config.resendFromEmail || !config.appBaseUrl || user.emailVerifiedAt) {
    return false;
  }

  const existingToken = db.getLatestPendingUserEmailVerificationToken(user.id);
  const token = existingToken?.token ?? createSessionToken().slice(0, 32);
  if (!existingToken) {
    db.createUserEmailVerificationToken(user.id, token, new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString());
  }

  const confirmUrl = `${config.appBaseUrl}/account/email/confirm?token=${encodeURIComponent(token)}`;
  await notifications.sendUserEmailVerification(user.email, confirmUrl);
  return true;
}

function bootstrapAdminUser(): void {
  if (db.countUsers() > 0) {
    return;
  }

  if (!config.bootstrapAdminEmail || !config.bootstrapAdminPassword) {
    return;
  }

  const userId = db.createUser({
    firstName: "Admin",
    lastName: "User",
    email: config.bootstrapAdminEmail,
    passwordHash: createPasswordHash(config.bootstrapAdminPassword),
    role: "admin",
    emailVerifiedAt: new Date().toISOString(),
    acceptLanguage: null,
    browserLocale: null,
    browserTimezone: null
  });
  const user = db.getUserById(userId);
  if (user) {
    ensureUserEmailNotificationChannel(user);
  }
}

app.get("/", async (request, reply) => {
  const user = getCurrentUser(request);
  if (user) {
    reply.redirect("/app");
    return;
  }
  reply.type("text/html").send(renderLandingPage());
});

app.get("/signup", async (_request, reply) => {
  reply.type("text/html").send(renderAuthPage({ mode: "signup" }));
});

app.post("/signup", async (request, reply) => {
  const body = request.body as Record<string, string | undefined>;
  const scrapePreferences = readScrapePreferences(request, body);
  const firstName = body.firstName?.trim() ?? "";
  const lastName = body.lastName?.trim() ?? "";
  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password?.trim() ?? "";

  if (!firstName || !lastName || !email || !password || password.length < 8) {
    reply.type("text/html").send(renderAuthPage({
      mode: "signup",
      error: "Provide first name, last name, a valid email, and a password of at least 8 characters.",
      values: { firstName, lastName, email }
    }));
    return;
  }

  if (db.getUserByEmail(email)) {
    reply.type("text/html").send(renderAuthPage({
      mode: "signup",
      error: "That email is already registered.",
      values: { firstName, lastName, email }
    }));
    return;
  }

  const userId = db.createUser({
    firstName,
    lastName,
    email,
    passwordHash: createPasswordHash(password),
    ...scrapePreferences
  });
  const user = db.getUserById(userId);
  if (!user) {
    reply.code(500).type("text/plain").send("Failed to create user.");
    return;
  }
  ensureUserEmailNotificationChannel(user);
  const sessionId = createSessionToken();
  db.createSession({
    id: sessionId,
    userId,
    expiresAt: buildSessionExpiry()
  });
  setSession(reply, sessionId);

  let notice = "Account created.";
  try {
    const sent = await sendAccountEmailVerification(user);
    if (sent) {
      notice = "Account created. Check your email to verify your default alert recipient.";
    } else if (!user.emailVerifiedAt) {
      notice = "Account created. Verify your email later from Settings once email delivery is configured.";
    }
  } catch (error) {
    notice = error instanceof Error
      ? `Account created, but the verification email could not be sent: ${error.message}`
      : "Account created, but the verification email could not be sent.";
  }

  setFlash(reply, { notice });
  reply.redirect("/app/onboarding");
});

app.get("/login", async (_request, reply) => {
  reply.type("text/html").send(renderAuthPage({ mode: "login" }));
});

app.get("/notifications/email/confirm", async (request, reply) => {
  const token = ((request.query as { token?: string }).token ?? "").trim();
  if (!token) {
    reply.type("text/html").send(renderAuthPage({
      mode: "login",
      error: "Missing confirmation token.",
      notice: null
    }));
    return;
  }

  const channel = db.consumeEmailVerificationToken(token);
  if (!channel) {
    reply.type("text/html").send(renderAuthPage({
      mode: "login",
      error: "That confirmation link is invalid or has expired.",
      notice: null
    }));
    return;
  }

  reply.type("text/html").send(renderAuthPage({
    mode: "login",
    notice: `Email alerts are now enabled for ${channel.target}. You can log in and continue using the app.`,
    error: null
  }));
});

app.get("/account/email/confirm", async (request, reply) => {
  const token = ((request.query as { token?: string }).token ?? "").trim();
  if (!token) {
    reply.type("text/html").send(renderAuthPage({
      mode: "login",
      error: "Missing verification token.",
      notice: null
    }));
    return;
  }

  const user = db.consumeUserEmailVerificationToken(token);
  if (!user) {
    reply.type("text/html").send(renderAuthPage({
      mode: "login",
      error: "That verification link is invalid or has expired.",
      notice: null
    }));
    return;
  }

  reply.type("text/html").send(renderAuthPage({
    mode: "login",
    notice: `${user.email} is verified and ready for price alerts.`,
    error: null
  }));
});

app.post("/login", async (request, reply) => {
  const body = request.body as Record<string, string | undefined>;
  const scrapePreferences = readScrapePreferences(request, body);
  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password?.trim() ?? "";
  const user = db.getUserByEmail(email);

  if (!user || !verifyPassword(password, user.passwordHash)) {
    reply.type("text/html").send(renderAuthPage({ mode: "login", error: "Invalid email or password." }));
    return;
  }

  ensureUserEmailNotificationChannel(user);
  persistUserScrapePreferences(user.id, scrapePreferences);
  const sessionId = createSessionToken();
  db.createSession({
    id: sessionId,
    userId: user.id,
    expiresAt: buildSessionExpiry()
  });
  setSession(reply, sessionId);
  reply.redirect("/app");
});

app.post("/logout", async (request, reply) => {
  const sessionId = request.cookies[config.sessionCookieName];
  if (sessionId) {
    db.deleteSession(sessionId);
  }
  clearSession(reply);
  reply.redirect("/");
});

app.get("/app", async (request, reply) => {
  const user = requireUser(request, reply);
  if (!user) {
    return;
  }
  ensureUserEmailNotificationChannel(user);

  const flash = readFlash(request);
  clearFlash(reply);
  reply.type("text/html").send(renderUserDashboard({
    user,
    items: db.listTrackedItemsWithHistoryForUser(user.id),
    detectionPreview: null,
    overrideName: null,
    ...flash,
    ...tracker.getStatus()
  }));
});

app.get("/app/onboarding", async (request, reply) => {
  const user = requireUser(request, reply);
  if (!user) {
    return;
  }
  ensureUserEmailNotificationChannel(user);

  if (db.listTrackedItemsForUser(user.id).length > 0) {
    reply.redirect("/app");
    return;
  }

  const flash = readFlash(request);
  clearFlash(reply);
  reply.type("text/html").send(renderOnboardingPage({
    user,
    detectionPreview: null,
    overrideName: null,
    ...flash
  }));
});

app.post("/app/onboarding/item", async (request, reply) => {
  const user = requireUser(request, reply);
  if (!user) {
    return;
  }
  ensureUserEmailNotificationChannel(user);

  const body = request.body as Record<string, string | undefined>;
  const scrapePreferences = readScrapePreferences(request, body);
  const url = body.url?.trim() ?? "";

  if (!url) {
    setFlash(reply, { error: "URL is required." });
    reply.redirect("/app/onboarding");
    return;
  }

  try {
    persistUserScrapePreferences(user.id, scrapePreferences);
    const detection = await detectTrackedItem(url, scrapePreferences);
    clearFlash(reply);
    reply.type("text/html").send(renderOnboardingPage({
      user,
      detectionPreview: detection,
      overrideName: null,
      notice: null,
      error: null
    }));
    return;
  } catch (error) {
    setFlash(reply, { error: error instanceof Error ? error.message : "Failed to detect a price on that URL." });
  }

  reply.redirect("/app/onboarding");
});

app.get("/app/admin", async (_request, reply) => {
  reply.redirect("/app/settings");
});

app.get("/app/settings", async (request, reply) => {
  const user = requireUser(request, reply);
  if (!user) {
    return;
  }
  ensureUserEmailNotificationChannel(user);

  try {
    await notifications.syncTelegramLinks(db);
  } catch {
    // Non-fatal. The page still loads and email notifications continue to work.
  }

  const flash = readFlash(request);
  clearFlash(reply);
  let telegramBotUsername: string | null = null;
  try {
    telegramBotUsername = await notifications.getTelegramBotUsername();
  } catch {
    telegramBotUsername = null;
  }

  reply.type("text/html").send(renderUserAdminPage({
    user,
    channels: db.listNotificationChannelsForUser(user.id),
    telegramLinks: db.listActiveTelegramLinkTokensForUser(user.id),
    telegramBotUsername,
    detectionPreview: null,
    overrideName: null,
    ...flash
  }));
});

app.post("/app/items", async (request, reply) => {
  const user = requireUser(request, reply);
  if (!user) {
    return;
  }

  const body = request.body as Record<string, string | undefined>;
  const scrapePreferences = readScrapePreferences(request, body);
  const url = body.url?.trim() ?? "";

  if (!url) {
    setFlash(reply, { error: "URL is required." });
    reply.redirect("/app");
    return;
  }

  try {
    persistUserScrapePreferences(user.id, scrapePreferences);
    const detection = await detectTrackedItem(url, scrapePreferences);
    clearFlash(reply);
    reply.type("text/html").send(renderUserDashboard({
      user,
      items: db.listTrackedItemsWithHistoryForUser(user.id),
      detectionPreview: detection,
      overrideName: null,
      notice: null,
      error: null,
      ...tracker.getStatus()
    }));
    return;
  } catch (error) {
    setFlash(reply, { error: error instanceof Error ? error.message : "Failed to detect a price on that URL." });
  }

  reply.redirect("/app");
});

app.post("/app/items/confirm", async (request, reply) => {
  const user = requireUser(request, reply);
  if (!user) {
    return;
  }

  const body = request.body as Record<string, string | undefined>;
  const name = body.name?.trim() ?? "";
  const url = body.url?.trim() ?? "";
  const selector = body.selector?.trim() || null;
  const currency = body.currency?.trim() ?? "";
  const initialDetectedPrice = body.initialDetectedPrice?.trim() || null;
  const initialDetectedCurrency = body.initialDetectedCurrency?.trim() || null;
  const initialDetectedRawText = body.initialDetectedRawText?.trim() || null;
  const attribute = body.attribute?.trim() || null;
  const regex = body.regex?.trim() || null;
  const htmlRegex = body.htmlRegex?.trim() || null;
  const pageTitle = body.pageTitle?.trim() || null;
  const detectionSource = body.detectionSource?.trim() || null;

  if (!name || !url || (!selector && !htmlRegex)) {
    setFlash(reply, { error: "The detection preview was incomplete. Please try again." });
    reply.redirect("/app");
    return;
  }

  db.createTrackedItem({
    ownerUserId: user.id,
    name,
    pageTitle,
    url,
    selector,
    currency,
    initialDetectedPrice,
    initialDetectedCurrency,
    initialDetectedRawText,
    firstDetectedAt: new Date().toISOString(),
    attribute,
    regex,
    htmlRegex,
    detectionSource,
    enabled: true
  });
  setFlash(reply, { notice: "Tracked item saved." });
  reply.redirect("/app");
});

app.post("/app/items/:id/delete", async (request, reply) => {
  const user = requireUser(request, reply);
  if (!user) {
    return;
  }

  const trackedItemId = Number.parseInt((request.params as { id: string }).id, 10);
  if (!Number.isFinite(trackedItemId)) {
    setFlash(reply, { error: "Invalid tracked item." });
    reply.redirect("/app");
    return;
  }

  const deleted = db.archiveTrackedItemForUser(trackedItemId, user.id);
  setFlash(reply, {
    notice: deleted ? "Tracked item archived. Its history will be restored if you add the same URL again." : undefined,
    error: deleted ? undefined : "Tracked item not found."
  });
  reply.redirect("/app");
});

app.post("/app/settings/email-verification/resend", async (request, reply) => {
  const user = requireUser(request, reply);
  if (!user) {
    return;
  }

  ensureUserEmailNotificationChannel(user);
  if (user.emailVerifiedAt) {
    setFlash(reply, { notice: "Your account email is already verified." });
    reply.redirect("/app/settings");
    return;
  }

  try {
    const sent = await sendAccountEmailVerification(user);
    setFlash(reply, {
      notice: sent
        ? "Verification email sent."
        : "Email delivery is not configured yet. Set RESEND_API_KEY, RESEND_FROM_EMAIL, and APP_BASE_URL first."
    });
  } catch (error) {
    setFlash(reply, {
      error: error instanceof Error ? error.message : "Failed to send verification email."
    });
  }

  reply.redirect("/app/settings");
});

app.post("/app/settings/notifications/telegram-links", async (request, reply) => {
  const user = requireUser(request, reply);
  if (!user) {
    return;
  }

  if (!config.telegramBotToken) {
    setFlash(reply, { error: "Telegram is not configured on this server yet." });
    reply.redirect("/app/settings");
    return;
  }

  const token = createSessionToken().slice(0, 24);
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
  db.createTelegramLinkToken(user.id, token, expiresAt);
  setFlash(reply, { notice: "Telegram connect link created. Share it with the recipient and ask them to tap Start in Telegram." });
  reply.redirect("/app/settings");
});

app.post("/checks/run", async (request, reply) => {
  const user = requireUser(request, reply);
  if (!user) {
    return;
  }

  await tracker.runAllChecks();
  setFlash(reply, { notice: "Price checks started." });
  reply.redirect("/app");
});

app.get("/admin", async (request, reply) => {
  const user = requireAdmin(request, reply);
  if (!user) {
    return;
  }

  const flash = readFlash(request);
  clearFlash(reply);
  reply.type("text/html").send(renderPlatformAdminPage({
    user,
    users: db.listUsersWithCounts(),
    items: db.listPlatformTrackedItems(),
    ...flash
  }));
});

app.post("/admin/test/email", async (request, reply) => {
  const user = requireAdmin(request, reply);
  if (!user) {
    return;
  }

  const body = request.body as Record<string, string | undefined>;
  const targets = (body.targets ?? "")
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);

  if (targets.length === 0) {
    setFlash(reply, { error: "Provide at least one email recipient." });
    reply.redirect("/admin");
    return;
  }

  try {
    for (const target of targets) {
      await notifications.sendTestEmail(target);
    }
    setFlash(reply, {
      notice: `${targets.length} test email${targets.length === 1 ? "" : "s"} sent.`
    });
  } catch (error) {
    setFlash(reply, {
      error: error instanceof Error ? error.message : "Failed to send test email."
    });
  }

  reply.redirect("/admin");
});

app.post("/admin/test/telegram", async (request, reply) => {
  const user = requireAdmin(request, reply);
  if (!user) {
    return;
  }

  const body = request.body as Record<string, string | undefined>;
  const targets = (body.targets ?? "")
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);

  if (targets.length === 0) {
    setFlash(reply, { error: "Provide at least one Telegram chat ID." });
    reply.redirect("/admin");
    return;
  }

  try {
    for (const target of targets) {
      await notifications.sendTestTelegram(target);
    }
    setFlash(reply, {
      notice: `${targets.length} Telegram test message${targets.length === 1 ? "" : "s"} sent.`
    });
  } catch (error) {
    setFlash(reply, {
      error: error instanceof Error ? error.message : "Failed to send Telegram test message."
    });
  }

  reply.redirect("/admin");
});

function startScheduler(): void {
  const intervalMs = config.checkIntervalMinutes * 60 * 1000;
  setInterval(() => {
    void tracker.runAllChecks();
  }, intervalMs);
}

function startTelegramSync(): void {
  if (!config.telegramBotToken) {
    return;
  }

  const runSync = () => {
    void notifications.syncTelegramLinks(db).catch((error) => {
      app.log.warn(error);
    });
  };

  runSync();
  setInterval(runSync, 15_000);
}

async function start(): Promise<void> {
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  bootstrapAdminUser();
  startScheduler();
  startTelegramSync();
  await app.listen({ host: config.host, port: config.port });
}

start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
