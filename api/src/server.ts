import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import fastifyStatic from "@fastify/static";
import { buildSessionExpiry, createPasswordHash, createSessionToken, verifyPassword } from "./auth.js";
import { config } from "./config.js";
import { AppDb } from "./db.js";
import { NotificationService } from "./notifications.js";
import { detectTrackedItem, fetchScrapeDebugResult, validateScrapeUrl } from "./scraper.js";
import { TrackerService } from "./tracker.js";
import type {
  NotificationChannelRecord,
  PlatformTrackedItem,
  PriceCheckRecord,
  ScrapePreferences,
  ScrapeDebugResult,
  TrackedItemRecord,
  TrackedItemWithHistory,
  UserRecord,
  UserWithCounts
} from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webDistDir = path.resolve(__dirname, "../../web/dist");
const webAssetsDir = path.join(webDistDir, "assets");
const hasWebBuild = fs.existsSync(path.join(webDistDir, "index.html"));
const webIndexHtml = hasWebBuild ? fs.readFileSync(path.join(webDistDir, "index.html"), "utf8") : null;

const app = Fastify({ logger: true });
const db = new AppDb(config.databasePath);
const notifications = new NotificationService({
  resendApiKey: config.resendApiKey,
  resendFromEmail: config.resendFromEmail,
  telegramBotToken: config.telegramBotToken,
  telegramBotUsername: config.telegramBotUsername
});
const tracker = new TrackerService(db, notifications);
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

await app.register(formbody);
await app.register(cookie);

if (hasWebBuild) {
  await app.register(fastifyStatic, {
    root: webAssetsDir,
    prefix: "/assets/",
    decorateReply: false
  });
}

type ApiUser = {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  role: UserRecord["role"];
  emailVerifiedAt: string | null;
  acceptLanguage: string | null;
  browserLocale: string | null;
  browserTimezone: string | null;
  createdAt: string;
};

function toApiUser(user: UserRecord): ApiUser {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    role: user.role,
    emailVerifiedAt: user.emailVerifiedAt,
    acceptLanguage: user.acceptLanguage,
    browserLocale: user.browserLocale,
    browserTimezone: user.browserTimezone,
    createdAt: user.createdAt
  };
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
  body: Record<string, unknown> | null = null
): ScrapePreferences {
  const rawAcceptLanguageHeader = request.headers["accept-language"];
  const headerAcceptLanguage = typeof rawAcceptLanguageHeader === "string" ? rawAcceptLanguageHeader : null;
  const bodyAcceptLanguage = typeof body?.acceptLanguage === "string" ? body.acceptLanguage : null;
  const bodyBrowserLocale = typeof body?.browserLocale === "string" ? body.browserLocale : null;
  const bodyBrowserTimezone = typeof body?.browserTimezone === "string" ? body.browserTimezone : null;
  const acceptLanguage = normalizeAcceptLanguage(bodyAcceptLanguage ?? headerAcceptLanguage);

  return {
    acceptLanguage,
    browserLocale: normalizeBrowserLocale(bodyBrowserLocale, acceptLanguage),
    browserTimezone: normalizeBrowserTimezone(bodyBrowserTimezone)
  };
}

function setSession(reply: FastifyReply, sessionId: string): void {
  reply.setCookie(config.sessionCookieName, sessionId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.secureCookies,
    maxAge: 60 * 60 * 24 * 30
  });
}

function clearSession(reply: FastifyReply): void {
  reply.clearCookie(config.sessionCookieName, { path: "/" });
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
    reply.code(401).send({ error: "Authentication required." });
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
    reply.code(403).send({ error: "Admin access required." });
    return null;
  }

  return user;
}

function enforceRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  bucketName: string,
  limit: number,
  windowMs: number
): boolean {
  const key = `${bucketName}:${request.ip}`;
  const now = Date.now();
  const current = rateLimitBuckets.get(key);
  if (!current || current.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (current.count >= limit) {
    reply.header("Retry-After", Math.ceil((current.resetAt - now) / 1000));
    reply.code(429).send({ error: "Too many requests. Please try again later." });
    return false;
  }

  current.count += 1;
  rateLimitBuckets.set(key, current);
  return true;
}

function persistUserScrapePreferences(userId: number, scrapePreferences: ScrapePreferences): void {
  db.updateUserScrapePreferences(userId, scrapePreferences);
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

function buildDashboardPayload(user: UserRecord): {
  user: ApiUser;
  items: TrackedItemWithHistory[];
} {
  ensureUserEmailNotificationChannel(user);
  return {
    user: toApiUser(user),
    items: db.listTrackedItemsWithHistoryForUser(user.id)
  };
}

function buildSettingsPayload(user: UserRecord, telegramBotUsername: string | null): {
  user: ApiUser;
  channels: NotificationChannelRecord[];
  telegramLinks: ReturnType<AppDb["listActiveTelegramLinkTokensForUser"]>;
  telegramBotUsername: string | null;
} {
  ensureUserEmailNotificationChannel(user);
  return {
    user: toApiUser(user),
    channels: db.listNotificationChannelsForUser(user.id),
    telegramLinks: db.listActiveTelegramLinkTokensForUser(user.id),
    telegramBotUsername
  };
}

function buildAdminPayload(user: UserRecord): {
  user: ApiUser;
  users: UserWithCounts[];
  items: PlatformTrackedItem[];
  tracker: { running: boolean; lastRunAt: string | null };
} {
  return {
    user: toApiUser(user),
    users: db.listUsersWithCounts(),
    items: db.listPlatformTrackedItems(),
    tracker: tracker.getStatus()
  };
}

function redirectWithMessage(reply: FastifyReply, pathname: string, params: Record<string, string>): void {
  const search = new URLSearchParams(params);
  reply.redirect(`${pathname}?${search.toString()}`);
}

app.get("/api/health", async () => ({
  ok: true
}));

app.get("/api/session", async (request) => {
  const user = getCurrentUser(request);
  if (!user) {
    return { authenticated: false, user: null };
  }

  ensureUserEmailNotificationChannel(user);
  return {
    authenticated: true,
    user: toApiUser(user)
  };
});

app.post("/api/auth/signup", async (request, reply) => {
  if (!enforceRateLimit(request, reply, "signup", 10, 15 * 60 * 1000)) {
    return;
  }
  const body = (request.body as Record<string, unknown> | undefined) ?? {};
  const scrapePreferences = readScrapePreferences(request, body);
  const firstName = typeof body.firstName === "string" ? body.firstName.trim() : "";
  const lastName = typeof body.lastName === "string" ? body.lastName.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password.trim() : "";

  if (!firstName || !lastName || !email || !password || password.length < 8) {
    reply.code(400).send({
      error: "Provide first name, last name, a valid email, and a password of at least 8 characters."
    });
    return;
  }

  if (db.getUserByEmail(email)) {
    reply.code(409).send({ error: "That email is already registered." });
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
    reply.code(500).send({ error: "Failed to create user." });
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

  reply.send({
    user: toApiUser(user),
    notice
  });
});

app.post("/api/auth/login", async (request, reply) => {
  if (!enforceRateLimit(request, reply, "login", 20, 15 * 60 * 1000)) {
    return;
  }
  const body = (request.body as Record<string, unknown> | undefined) ?? {};
  const scrapePreferences = readScrapePreferences(request, body);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password.trim() : "";
  const user = db.getUserByEmail(email);

  if (!user || !verifyPassword(password, user.passwordHash)) {
    reply.code(401).send({ error: "Invalid email or password." });
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

  reply.send({
    user: toApiUser(user),
    notice: "Signed in."
  });
});

app.post("/api/auth/logout", async (request, reply) => {
  const sessionId = request.cookies[config.sessionCookieName];
  if (sessionId) {
    db.deleteSession(sessionId);
  }

  clearSession(reply);
  reply.code(204).send();
});

app.get("/api/dashboard", async (request, reply) => {
  const user = requireUser(request, reply);
  if (!user) {
    return;
  }

  reply.send(buildDashboardPayload(user));
});

app.post("/api/items/detect", async (request, reply) => {
  const user = requireUser(request, reply);
  if (!user) {
    return;
  }
  if (!enforceRateLimit(request, reply, "detect", 30, 15 * 60 * 1000)) {
    return;
  }

  const body = (request.body as Record<string, unknown> | undefined) ?? {};
  const scrapePreferences = readScrapePreferences(request, body);
  const url = typeof body.url === "string" ? body.url.trim() : "";

  if (!url) {
    reply.code(400).send({ error: "URL is required." });
    return;
  }

  try {
    persistUserScrapePreferences(user.id, scrapePreferences);
    const detection = await detectTrackedItem(url, scrapePreferences);
    reply.send({ detection });
  } catch (error) {
    reply.code(400).send({
      error: "Could not check that URL right now."
    });
  }
});

app.post("/api/items", async (request, reply) => {
  const user = requireUser(request, reply);
  if (!user) {
    return;
  }

  const body = (request.body as Record<string, unknown> | undefined) ?? {};
  const scrapePreferences = readScrapePreferences(request, body);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const currency = typeof body.currency === "string" ? body.currency.trim() : "";
  const initialDetectedPrice = typeof body.initialDetectedPrice === "string" ? body.initialDetectedPrice.trim() || null : null;
  const initialDetectedCurrency = typeof body.initialDetectedCurrency === "string" ? body.initialDetectedCurrency.trim() || null : null;
  const initialDetectedRawText = typeof body.initialDetectedRawText === "string" ? body.initialDetectedRawText.trim() || null : null;
  const initialDetectedAvailability = body.initialDetectedAvailability === "available" || body.initialDetectedAvailability === "unavailable"
    ? body.initialDetectedAvailability
    : null;
  const pageTitle = typeof body.pageTitle === "string" ? body.pageTitle.trim() || null : null;
  const detectionSource = typeof body.detectionSource === "string" ? body.detectionSource.trim() || null : null;

  if (!name || !url || !currency || !initialDetectedPrice) {
    reply.code(400).send({ error: "The detection preview was incomplete. Please try again." });
    return;
  }
  try {
    await validateScrapeUrl(url);
  } catch {
    reply.code(400).send({ error: "That URL is not allowed." });
    return;
  }

  persistUserScrapePreferences(user.id, scrapePreferences);
  const trackedItemId = db.createTrackedItem({
    ownerUserId: user.id,
    name,
    pageTitle,
    url,
    acceptLanguage: scrapePreferences.acceptLanguage,
    browserLocale: scrapePreferences.browserLocale,
    browserTimezone: scrapePreferences.browserTimezone,
    currency,
    initialDetectedAvailability,
    initialDetectedPrice,
    initialDetectedCurrency,
    initialDetectedRawText,
    firstDetectedAt: new Date().toISOString(),
    detectionSource,
    enabled: true
  });

  reply.send({
    trackedItemId,
    notice: "Tracked item saved.",
    dashboard: buildDashboardPayload(user)
  });
});

app.delete("/api/items/:id", async (request, reply) => {
  const user = requireUser(request, reply);
  if (!user) {
    return;
  }

  const trackedItemId = Number.parseInt((request.params as { id: string }).id, 10);
  if (!Number.isFinite(trackedItemId)) {
    reply.code(400).send({ error: "Invalid tracked item." });
    return;
  }

  const deleted = db.archiveTrackedItemForUser(trackedItemId, user.id);
  if (!deleted) {
    reply.code(404).send({ error: "Tracked item not found." });
    return;
  }

  reply.send({
    notice: "Tracked item archived. Its history will be restored if you add the same URL again.",
    dashboard: buildDashboardPayload(user)
  });
});

app.post("/api/checks/run", async (request, reply) => {
  const user = requireAdmin(request, reply);
  if (!user) {
    return;
  }

  const result = await tracker.runChecksForUser(user.id);
  reply.send({
    notice: `Scraped ${result.checked} enabled item${result.checked === 1 ? "" : "s"} for your admin account.`,
    runSummary: {
      checked: result.checked,
      successes: result.successes,
      errors: result.errors,
      items: result.items
    },
    admin: buildAdminPayload(user)
  });
});

app.get("/api/settings", async (request, reply) => {
  const user = requireUser(request, reply);
  if (!user) {
    return;
  }

  try {
    await notifications.syncTelegramLinks(db);
  } catch {
    // Non-fatal. Settings can still render without the latest Telegram state.
  }

  let telegramBotUsername: string | null = null;
  try {
    telegramBotUsername = await notifications.getTelegramBotUsername();
  } catch {
    telegramBotUsername = null;
  }

  reply.send(buildSettingsPayload(user, telegramBotUsername));
});

app.post("/api/settings/email-verification/resend", async (request, reply) => {
  const user = requireUser(request, reply);
  if (!user) {
    return;
  }

  ensureUserEmailNotificationChannel(user);
  if (user.emailVerifiedAt) {
    reply.send({ notice: "Your account email is already verified." });
    return;
  }

  try {
    const sent = await sendAccountEmailVerification(user);
    reply.send({
      notice: sent
        ? "Verification email sent."
        : "Email delivery is not configured yet. Set RESEND_API_KEY, RESEND_FROM_EMAIL, and APP_BASE_URL first."
    });
  } catch (error) {
    reply.code(400).send({
      error: error instanceof Error ? error.message : "Failed to send verification email."
    });
  }
});

app.post("/api/settings/notifications/telegram-links", async (request, reply) => {
  const user = requireUser(request, reply);
  if (!user) {
    return;
  }

  if (!config.telegramBotToken) {
    reply.code(400).send({ error: "Telegram is not configured on this server yet." });
    return;
  }

  const token = createSessionToken().slice(0, 24);
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
  db.createTelegramLinkToken(user.id, token, expiresAt);

  let telegramBotUsername: string | null = null;
  try {
    telegramBotUsername = await notifications.getTelegramBotUsername();
  } catch {
    telegramBotUsername = null;
  }

  reply.send({
    notice: "Telegram connect link created. Share it with the recipient and ask them to tap Start in Telegram.",
    settings: buildSettingsPayload(user, telegramBotUsername)
  });
});

app.get("/api/admin", async (request, reply) => {
  const user = requireAdmin(request, reply);
  if (!user) {
    return;
  }

  reply.send(buildAdminPayload(user));
});

app.patch("/api/admin/users/:id", async (request, reply) => {
  const user = requireAdmin(request, reply);
  if (!user) {
    return;
  }

  const userId = Number.parseInt((request.params as { id: string }).id, 10);
  if (!Number.isFinite(userId)) {
    reply.code(400).send({ error: "Invalid user." });
    return;
  }

  const body = (request.body as Record<string, unknown> | undefined) ?? {};
  const firstName = typeof body.firstName === "string" ? body.firstName.trim() : "";
  const lastName = typeof body.lastName === "string" ? body.lastName.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const role = body.role === "admin" ? "admin" : body.role === "user" ? "user" : null;
  const isActive = body.isActive === true;

  if (!firstName || !lastName || !email || !role) {
    reply.code(400).send({ error: "Provide the user's name, email, and role." });
    return;
  }

  if (userId === user.id && (!isActive || role !== "admin")) {
    reply.code(400).send({ error: "You cannot disable or remove your own admin access." });
    return;
  }

  try {
    const updated = db.updateUserByAdmin({ userId, firstName, lastName, email, role, isActive });
    if (!updated) {
      reply.code(404).send({ error: "User not found." });
      return;
    }

    reply.send({
      notice: "User updated.",
      admin: buildAdminPayload(user)
    });
  } catch (error) {
    reply.code(400).send({
      error: error instanceof Error ? error.message : "Failed to update user."
    });
  }
});

app.delete("/api/admin/users/:id", async (request, reply) => {
  const user = requireAdmin(request, reply);
  if (!user) {
    return;
  }

  const userId = Number.parseInt((request.params as { id: string }).id, 10);
  if (!Number.isFinite(userId)) {
    reply.code(400).send({ error: "Invalid user." });
    return;
  }

  if (userId === user.id) {
    reply.code(400).send({ error: "You cannot delete your own account from admin." });
    return;
  }

  const deleted = db.deleteUserByAdmin(userId);
  if (!deleted) {
    reply.code(404).send({ error: "User not found." });
    return;
  }

  reply.send({
    notice: "User deleted.",
    admin: buildAdminPayload(user)
  });
});

app.patch("/api/admin/items/:id", async (request, reply) => {
  const user = requireAdmin(request, reply);
  if (!user) {
    return;
  }

  const trackedItemId = Number.parseInt((request.params as { id: string }).id, 10);
  if (!Number.isFinite(trackedItemId)) {
    reply.code(400).send({ error: "Invalid tracked item." });
    return;
  }

  const body = (request.body as Record<string, unknown> | undefined) ?? {};
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const enabled = body.enabled === true;

  if (!name || !url) {
    reply.code(400).send({ error: "Provide the tracked item name and URL." });
    return;
  }
  try {
    await validateScrapeUrl(url);
  } catch {
    reply.code(400).send({ error: "That URL is not allowed." });
    return;
  }

  const updated = db.updateTrackedItemByAdmin({ trackedItemId, name, url, enabled });
  if (!updated) {
    reply.code(404).send({ error: "Tracked item not found." });
    return;
  }

  reply.send({
    notice: "Tracked item updated.",
    admin: buildAdminPayload(user)
  });
});

app.delete("/api/admin/items/:id", async (request, reply) => {
  const user = requireAdmin(request, reply);
  if (!user) {
    return;
  }

  const trackedItemId = Number.parseInt((request.params as { id: string }).id, 10);
  if (!Number.isFinite(trackedItemId)) {
    reply.code(400).send({ error: "Invalid tracked item." });
    return;
  }

  const deleted = db.deleteTrackedItemByAdmin(trackedItemId);
  if (!deleted) {
    reply.code(404).send({ error: "Tracked item not found." });
    return;
  }

  reply.send({
    notice: "Tracked item deleted.",
    admin: buildAdminPayload(user)
  });
});

app.post("/api/admin/test/email", async (request, reply) => {
  const user = requireAdmin(request, reply);
  if (!user) {
    return;
  }

  const body = (request.body as Record<string, unknown> | undefined) ?? {};
  const rawTargets = typeof body.targets === "string" ? body.targets : "";
  const targets = rawTargets
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);

  if (targets.length === 0) {
    reply.code(400).send({ error: "Provide at least one email recipient." });
    return;
  }

  try {
    for (const target of targets) {
      await notifications.sendTestEmail(target);
    }
    reply.send({
      notice: `${targets.length} test email${targets.length === 1 ? "" : "s"} sent.`
    });
  } catch (error) {
    reply.code(400).send({
      error: error instanceof Error ? error.message : "Failed to send test email."
    });
  }
});

app.post("/api/admin/test/telegram", async (request, reply) => {
  const user = requireAdmin(request, reply);
  if (!user) {
    return;
  }

  const body = (request.body as Record<string, unknown> | undefined) ?? {};
  const rawTargets = typeof body.targets === "string" ? body.targets : "";
  const targets = rawTargets
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);

  if (targets.length === 0) {
    reply.code(400).send({ error: "Provide at least one Telegram chat ID." });
    return;
  }

  try {
    for (const target of targets) {
      await notifications.sendTestTelegram(target);
    }
    reply.send({
      notice: `${targets.length} Telegram test message${targets.length === 1 ? "" : "s"} sent.`
    });
  } catch (error) {
    reply.code(400).send({
      error: error instanceof Error ? error.message : "Failed to send Telegram test message."
    });
  }
});

app.post("/api/admin/scrape-debug", async (request, reply) => {
  const user = requireAdmin(request, reply);
  if (!user) {
    return;
  }
  if (!enforceRateLimit(request, reply, "admin-scrape-debug", 20, 15 * 60 * 1000)) {
    return;
  }

  const body = (request.body as Record<string, unknown> | undefined) ?? {};
  const url = typeof body.url === "string" ? body.url.trim() : "";

  if (!url) {
    reply.code(400).send({ error: "Provide a URL to fetch." });
    return;
  }

  const scrapePreferences = readScrapePreferences(request, body);
  const scrapeDebug: ScrapeDebugResult = await fetchScrapeDebugResult(url, scrapePreferences);

  reply.send({
    notice: scrapeDebug.html ? "Fetched the page through the scraper pipeline." : null,
    error: scrapeDebug.html ? null : scrapeDebug.errorMessage ?? scrapeDebug.blockedMessage ?? null,
    scrapeDebug
  });
});

app.get("/notifications/email/confirm", async (request, reply) => {
  const token = ((request.query as { token?: string }).token ?? "").trim();
  if (!token) {
    redirectWithMessage(reply, "/login", { error: "Missing confirmation token." });
    return;
  }

  const channel = db.consumeEmailVerificationToken(token);
  if (!channel) {
    redirectWithMessage(reply, "/login", { error: "That confirmation link is invalid or has expired." });
    return;
  }

  redirectWithMessage(reply, "/login", {
    notice: `Email alerts are now enabled for ${channel.target}. You can log in and continue using the app.`
  });
});

app.get("/account/email/confirm", async (request, reply) => {
  const token = ((request.query as { token?: string }).token ?? "").trim();
  if (!token) {
    redirectWithMessage(reply, "/login", { error: "Missing verification token." });
    return;
  }

  const user = db.consumeUserEmailVerificationToken(token);
  if (!user) {
    redirectWithMessage(reply, "/login", { error: "That verification link is invalid or has expired." });
    return;
  }

  redirectWithMessage(reply, "/login", {
    notice: `${user.email} is verified and ready for price alerts.`
  });
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

if (hasWebBuild) {
  app.get("/", async (_request, reply) => {
    reply.type("text/html; charset=utf-8").send(webIndexHtml);
  });

  app.get("/*", async (request, reply) => {
    if ((request.raw.url ?? "").startsWith("/api/")) {
      reply.code(404).send({ error: "Not found." });
      return;
    }

    reply.type("text/html; charset=utf-8").send(webIndexHtml);
  });
} else {
  app.get("/", async () => ({
    ok: true,
    message: "PriceBuzz API is running. Start the Vite dev server for the web UI."
  }));
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
