import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { utcNow } from "./utils.js";
import type {
  AlertDeliveryRecord,
  EmailVerificationTokenRecord,
  NotificationChannelRecord,
  NotificationChannelType,
  PlatformTrackedItem,
  PriceCheckRecord,
  SessionRecord,
  TelegramLinkTokenRecord,
  TrackedItemInput,
  TrackedItemRecord,
  TrackedItemWithHistory,
  UserEmailVerificationTokenRecord,
  UserRecord,
  UserRole,
  UserWithCounts
} from "./types.js";

export class AppDb {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        first_name TEXT NOT NULL DEFAULT '',
        last_name TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        is_active INTEGER NOT NULL DEFAULT 1,
        email_verified_at TEXT,
        accept_language TEXT,
        browser_locale TEXT,
        browser_timezone TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS tracked_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        page_title TEXT,
        url TEXT NOT NULL,
        selector TEXT,
        currency TEXT NOT NULL DEFAULT '',
        attribute TEXT,
        regex TEXT,
        html_regex TEXT,
        headers_json TEXT,
        detection_source TEXT,
        initial_detected_price TEXT,
        initial_detected_currency TEXT,
        initial_detected_raw_text TEXT,
        first_detected_at TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS price_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tracked_item_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        price TEXT,
        currency TEXT,
        raw_text TEXT,
        error_message TEXT,
        FOREIGN KEY (tracked_item_id) REFERENCES tracked_items (id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS notification_channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        target TEXT NOT NULL,
        display_name TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        verified_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS telegram_link_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        claimed_at TEXT,
        claimed_channel_id INTEGER,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
        FOREIGN KEY (claimed_channel_id) REFERENCES notification_channels (id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS email_verification_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id INTEGER NOT NULL,
        token TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        used_at TEXT,
        FOREIGN KEY (channel_id) REFERENCES notification_channels (id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS user_email_verification_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        used_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS alert_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tracked_item_id INTEGER NOT NULL,
        channel_id INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (tracked_item_id) REFERENCES tracked_items (id) ON DELETE CASCADE,
        FOREIGN KEY (channel_id) REFERENCES notification_channels (id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);
      CREATE INDEX IF NOT EXISTS idx_price_checks_tracked_item_checked_at
      ON price_checks (tracked_item_id, checked_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tracked_items_owner_user_id
      ON tracked_items (owner_user_id);
      CREATE INDEX IF NOT EXISTS idx_notification_channels_user_id
      ON notification_channels (user_id);
      CREATE INDEX IF NOT EXISTS idx_telegram_link_tokens_user_id
      ON telegram_link_tokens (user_id);
      CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_channel_id
      ON email_verification_tokens (channel_id);
      CREATE INDEX IF NOT EXISTS idx_user_email_verification_tokens_user_id
      ON user_email_verification_tokens (user_id);
    `);

    this.ensureColumn("users", "first_name", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("users", "last_name", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("users", "email_verified_at", "TEXT");
    this.ensureColumn("users", "accept_language", "TEXT");
    this.ensureColumn("users", "browser_locale", "TEXT");
    this.ensureColumn("users", "browser_timezone", "TEXT");
  }

  private ensureColumn(tableName: string, columnName: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === columnName)) {
      return;
    }

    this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }

  countUsers(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
    return row.count;
  }

  createUser(input: {
    firstName: string;
    lastName: string;
    email: string;
    passwordHash: string;
    role?: UserRole;
    emailVerifiedAt?: string | null;
    acceptLanguage?: string | null;
    browserLocale?: string | null;
    browserTimezone?: string | null;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO users (
        first_name, last_name, email, password_hash, role, is_active, email_verified_at,
        accept_language, browser_locale, browser_timezone, created_at
      )
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).run(
      input.firstName.trim(),
      input.lastName.trim(),
      input.email.trim().toLowerCase(),
      input.passwordHash,
      input.role ?? "user",
      input.emailVerifiedAt ?? null,
      input.acceptLanguage?.trim() || null,
      input.browserLocale?.trim() || null,
      input.browserTimezone?.trim() || null,
      utcNow()
    );

    return Number(result.lastInsertRowid);
  }

  getUserByEmail(email: string): UserRecord | null {
    const row = this.db.prepare(`
      SELECT
        id,
        first_name AS firstName,
        last_name AS lastName,
        email,
        password_hash AS passwordHash,
        role,
        is_active AS isActive,
        email_verified_at AS emailVerifiedAt,
        accept_language AS acceptLanguage,
        browser_locale AS browserLocale,
        browser_timezone AS browserTimezone,
        created_at AS createdAt
      FROM users
      WHERE email = ?
    `).get(email.trim().toLowerCase()) as (Omit<UserRecord, "isActive"> & { isActive: number }) | undefined;

    if (!row) {
      return null;
    }

    return {
      ...row,
      isActive: Boolean(row.isActive)
    };
  }

  getUserById(userId: number): UserRecord | null {
    const row = this.db.prepare(`
      SELECT
        id,
        first_name AS firstName,
        last_name AS lastName,
        email,
        password_hash AS passwordHash,
        role,
        is_active AS isActive,
        email_verified_at AS emailVerifiedAt,
        accept_language AS acceptLanguage,
        browser_locale AS browserLocale,
        browser_timezone AS browserTimezone,
        created_at AS createdAt
      FROM users
      WHERE id = ?
    `).get(userId) as (Omit<UserRecord, "isActive"> & { isActive: number }) | undefined;

    if (!row) {
      return null;
    }

    return {
      ...row,
      isActive: Boolean(row.isActive)
    };
  }

  createSession(input: SessionRecord): void {
    this.db.prepare(`
      INSERT INTO sessions (id, user_id, expires_at)
      VALUES (?, ?, ?)
    `).run(input.id, input.userId, input.expiresAt);
  }

  deleteSession(sessionId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  }

  getSessionUser(sessionId: string): UserRecord | null {
    const row = this.db.prepare(`
      SELECT
        users.id,
        users.first_name AS firstName,
        users.last_name AS lastName,
        users.email,
        users.password_hash AS passwordHash,
        users.role,
        users.is_active AS isActive,
        users.email_verified_at AS emailVerifiedAt,
        users.accept_language AS acceptLanguage,
        users.browser_locale AS browserLocale,
        users.browser_timezone AS browserTimezone,
        users.created_at AS createdAt
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.id = ? AND sessions.expires_at > ?
    `).get(sessionId, utcNow()) as (Omit<UserRecord, "isActive"> & { isActive: number }) | undefined;

    if (!row) {
      return null;
    }

    return {
      ...row,
      isActive: Boolean(row.isActive)
    };
  }

  markUserEmailVerified(userId: number, verifiedAt: string): void {
    this.db.prepare(`
      UPDATE users
      SET email_verified_at = ?
      WHERE id = ?
    `).run(verifiedAt, userId);
  }

  updateUserScrapePreferences(userId: number, input: {
    acceptLanguage?: string | null;
    browserLocale?: string | null;
    browserTimezone?: string | null;
  }): void {
    this.db.prepare(`
      UPDATE users
      SET
        accept_language = COALESCE(@acceptLanguage, accept_language),
        browser_locale = COALESCE(@browserLocale, browser_locale),
        browser_timezone = COALESCE(@browserTimezone, browser_timezone)
      WHERE id = @userId
    `).run({
      userId,
      acceptLanguage: input.acceptLanguage?.trim() || null,
      browserLocale: input.browserLocale?.trim() || null,
      browserTimezone: input.browserTimezone?.trim() || null
    });
  }

  createTrackedItem(input: TrackedItemInput): number {
    const existing = this.db.prepare(`
      SELECT id
      FROM tracked_items
      WHERE owner_user_id = ? AND url = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(input.ownerUserId, input.url.trim()) as { id: number } | undefined;

    const now = utcNow();
    const initialCheckedAt = input.firstDetectedAt?.trim() || now;
    if (existing) {
      this.db.prepare(`
        UPDATE tracked_items
        SET
          name = @name,
          page_title = @pageTitle,
          selector = @selector,
          currency = @currency,
          attribute = @attribute,
          regex = @regex,
          html_regex = @htmlRegex,
          headers_json = @headersJson,
          detection_source = @detectionSource,
          initial_detected_price = COALESCE(initial_detected_price, @initialDetectedPrice),
          initial_detected_currency = COALESCE(initial_detected_currency, @initialDetectedCurrency),
          initial_detected_raw_text = COALESCE(initial_detected_raw_text, @initialDetectedRawText),
          first_detected_at = COALESCE(first_detected_at, @firstDetectedAt),
          enabled = @enabled,
          archived_at = NULL,
          updated_at = @updatedAt
        WHERE id = @id
      `).run({
        id: existing.id,
        name: input.name.trim(),
        pageTitle: input.pageTitle?.trim() || null,
        selector: input.selector?.trim() || null,
        currency: input.currency?.trim() ?? "",
        attribute: input.attribute?.trim() || null,
        regex: input.regex?.trim() || null,
        htmlRegex: input.htmlRegex?.trim() || null,
        headersJson: input.headers ? JSON.stringify(input.headers) : null,
        detectionSource: input.detectionSource?.trim() || null,
        initialDetectedPrice: input.initialDetectedPrice?.trim() || null,
        initialDetectedCurrency: input.initialDetectedCurrency?.trim() || null,
        initialDetectedRawText: input.initialDetectedRawText?.trim() || null,
        firstDetectedAt: input.firstDetectedAt?.trim() || now,
        enabled: input.enabled === false ? 0 : 1,
        updatedAt: now
      });

      this.insertInitialPriceCheckIfMissing(existing.id, {
        price: input.initialDetectedPrice?.trim() || null,
        currency: input.initialDetectedCurrency?.trim() || input.currency?.trim() || null,
        rawText: input.initialDetectedRawText?.trim() || null,
        checkedAt: initialCheckedAt
      });

      return existing.id;
    }

    const result = this.db.prepare(`
      INSERT INTO tracked_items (
        owner_user_id, name, page_title, url, selector, currency, attribute, regex, html_regex,
        headers_json, detection_source, initial_detected_price, initial_detected_currency, initial_detected_raw_text,
        first_detected_at, enabled, archived_at, created_at, updated_at
      ) VALUES (
        @ownerUserId, @name, @pageTitle, @url, @selector, @currency, @attribute, @regex, @htmlRegex,
        @headersJson, @detectionSource, @initialDetectedPrice, @initialDetectedCurrency, @initialDetectedRawText,
        @firstDetectedAt, @enabled, @archivedAt, @createdAt, @updatedAt
      )
    `).run({
      ownerUserId: input.ownerUserId,
      name: input.name.trim(),
      pageTitle: input.pageTitle?.trim() || null,
      url: input.url.trim(),
      selector: input.selector?.trim() || null,
      currency: input.currency?.trim() ?? "",
      attribute: input.attribute?.trim() || null,
      regex: input.regex?.trim() || null,
      htmlRegex: input.htmlRegex?.trim() || null,
      headersJson: input.headers ? JSON.stringify(input.headers) : null,
      detectionSource: input.detectionSource?.trim() || null,
      initialDetectedPrice: input.initialDetectedPrice?.trim() || null,
      initialDetectedCurrency: input.initialDetectedCurrency?.trim() || null,
      initialDetectedRawText: input.initialDetectedRawText?.trim() || null,
      firstDetectedAt: input.firstDetectedAt?.trim() || now,
      enabled: input.enabled === false ? 0 : 1,
      archivedAt: null,
      createdAt: now,
      updatedAt: now
    });

    const trackedItemId = Number(result.lastInsertRowid);
    this.insertInitialPriceCheckIfMissing(trackedItemId, {
      price: input.initialDetectedPrice?.trim() || null,
      currency: input.initialDetectedCurrency?.trim() || input.currency?.trim() || null,
      rawText: input.initialDetectedRawText?.trim() || null,
      checkedAt: initialCheckedAt
    });

    return trackedItemId;
  }

  private insertInitialPriceCheckIfMissing(trackedItemId: number, input: {
    price: string | null;
    currency: string | null;
    rawText: string | null;
    checkedAt: string;
  }): void {
    if (!input.price) {
      return;
    }

    const existingCheck = this.db.prepare(`
      SELECT id
      FROM price_checks
      WHERE tracked_item_id = ?
      LIMIT 1
    `).get(trackedItemId) as { id: number } | undefined;

    if (existingCheck) {
      return;
    }

    this.db.prepare(`
      INSERT INTO price_checks (tracked_item_id, status, checked_at, price, currency, raw_text, error_message)
      VALUES (?, 'ok', ?, ?, ?, ?, NULL)
    `).run(
      trackedItemId,
      input.checkedAt,
      input.price,
      input.currency,
      input.rawText
    );
  }

  archiveTrackedItemForUser(trackedItemId: number, userId: number): boolean {
    const result = this.db.prepare(`
      UPDATE tracked_items
      SET archived_at = ?, enabled = 0, updated_at = ?
      WHERE id = ? AND owner_user_id = ? AND archived_at IS NULL
    `).run(utcNow(), utcNow(), trackedItemId, userId);

    return result.changes > 0;
  }

  listTrackedItemsForUser(userId: number): TrackedItemRecord[] {
    const rows = this.db.prepare(`
      SELECT
        id,
        owner_user_id AS ownerUserId,
        name,
        page_title AS pageTitle,
        url,
        selector,
        currency,
        attribute,
        regex,
        html_regex AS htmlRegex,
        headers_json AS headersJson,
        detection_source AS detectionSource,
        initial_detected_price AS initialDetectedPrice,
        initial_detected_currency AS initialDetectedCurrency,
        initial_detected_raw_text AS initialDetectedRawText,
        first_detected_at AS firstDetectedAt,
        enabled,
        archived_at AS archivedAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM tracked_items
      WHERE owner_user_id = ? AND archived_at IS NULL
      ORDER BY created_at DESC, id DESC
    `).all(userId) as Array<Omit<TrackedItemRecord, "enabled"> & { enabled: number }>;

    return rows.map((row) => ({
      ...row,
      enabled: Boolean(row.enabled)
    }));
  }

  listEnabledTrackedItems(): TrackedItemRecord[] {
    const rows = this.db.prepare(`
      SELECT
        id,
        owner_user_id AS ownerUserId,
        name,
        page_title AS pageTitle,
        url,
        selector,
        currency,
        attribute,
        regex,
        html_regex AS htmlRegex,
        headers_json AS headersJson,
        detection_source AS detectionSource,
        initial_detected_price AS initialDetectedPrice,
        initial_detected_currency AS initialDetectedCurrency,
        initial_detected_raw_text AS initialDetectedRawText,
        first_detected_at AS firstDetectedAt,
        enabled,
        archived_at AS archivedAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM tracked_items
      WHERE enabled = 1 AND archived_at IS NULL
      ORDER BY created_at ASC, id ASC
    `).all() as Array<Omit<TrackedItemRecord, "enabled"> & { enabled: number }>;

    return rows.map((row) => ({
      ...row,
      enabled: Boolean(row.enabled)
    }));
  }

  listTrackedItemsWithHistoryForUser(userId: number, limit = 12): TrackedItemWithHistory[] {
    return this.listTrackedItemsForUser(userId).map((item) => {
      const history = this.getRecentChecks(item.id, limit);
      const latestCheck = history[0] ?? null;
      const lowestPriceRow = this.db.prepare(`
        SELECT MIN(CAST(price AS REAL)) AS lowestPrice
        FROM price_checks
        WHERE tracked_item_id = ? AND status = 'ok' AND price IS NOT NULL
      `).get(item.id) as { lowestPrice: number | null };

      return {
        ...item,
        latestCheck,
        lowestPrice: lowestPriceRow.lowestPrice === null ? null : lowestPriceRow.lowestPrice.toFixed(2),
        history
      };
    });
  }

  insertPriceCheck(input: {
    trackedItemId: number;
    status: "ok" | "error";
    checkedAt: string;
    price?: string | null;
    currency?: string | null;
    rawText?: string | null;
    errorMessage?: string | null;
  }): void {
    this.db.prepare(`
      INSERT INTO price_checks (
        tracked_item_id, status, checked_at, price, currency, raw_text, error_message
      ) VALUES (
        @trackedItemId, @status, @checkedAt, @price, @currency, @rawText, @errorMessage
      )
    `).run({
      trackedItemId: input.trackedItemId,
      status: input.status,
      checkedAt: input.checkedAt,
      price: input.price ?? null,
      currency: input.currency ?? null,
      rawText: input.rawText ?? null,
      errorMessage: input.errorMessage ?? null
    });
  }

  getLatestSuccessfulCheck(trackedItemId: number): PriceCheckRecord | null {
    const row = this.db.prepare(`
      SELECT
        id,
        tracked_item_id AS trackedItemId,
        status,
        checked_at AS checkedAt,
        price,
        currency,
        raw_text AS rawText,
        error_message AS errorMessage
      FROM price_checks
      WHERE tracked_item_id = ? AND status = 'ok'
      ORDER BY checked_at DESC, id DESC
      LIMIT 1
    `).get(trackedItemId) as PriceCheckRecord | undefined;

    return row ?? null;
  }

  getRecentChecks(trackedItemId: number, limit: number): PriceCheckRecord[] {
    return this.db.prepare(`
      SELECT
        id,
        tracked_item_id AS trackedItemId,
        status,
        checked_at AS checkedAt,
        price,
        currency,
        raw_text AS rawText,
        error_message AS errorMessage
      FROM price_checks
      WHERE tracked_item_id = ?
      ORDER BY checked_at DESC, id DESC
      LIMIT ?
    `).all(trackedItemId, limit) as PriceCheckRecord[];
  }

  createNotificationChannel(
    userId: number,
    type: NotificationChannelType,
    target: string,
    displayName?: string | null,
    verifiedAt?: string | null
  ): number {
    const normalizedTarget = target.trim();
    const normalizedDisplayName = displayName?.trim() || null;
    const normalizedVerifiedAt = verifiedAt ?? null;
    const existing = this.db.prepare(`
      SELECT id
      FROM notification_channels
      WHERE user_id = ? AND type = ? AND target = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(userId, type, normalizedTarget) as { id: number } | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE notification_channels
        SET enabled = 1, display_name = ?, verified_at = COALESCE(?, verified_at)
        WHERE id = ?
      `).run(normalizedDisplayName, normalizedVerifiedAt, existing.id);

      return existing.id;
    }

    const result = this.db.prepare(`
      INSERT INTO notification_channels (user_id, type, target, display_name, enabled, verified_at, created_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(userId, type, normalizedTarget, normalizedDisplayName, normalizedVerifiedAt, utcNow());

    return Number(result.lastInsertRowid);
  }

  listNotificationChannelsForUser(userId: number): NotificationChannelRecord[] {
    const rows = this.db.prepare(`
      SELECT
        id,
        user_id AS userId,
        type,
        target,
        display_name AS displayName,
        enabled,
        verified_at AS verifiedAt,
        created_at AS createdAt
      FROM notification_channels
      WHERE user_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(userId) as Array<Omit<NotificationChannelRecord, "enabled"> & { enabled: number }>;

    return rows.map((row) => ({
      ...row,
      enabled: Boolean(row.enabled)
    }));
  }

  createTelegramLinkToken(userId: number, token: string, expiresAt: string): number {
    const now = utcNow();
    const result = this.db.prepare(`
      INSERT INTO telegram_link_tokens (user_id, token, expires_at, created_at, claimed_at, claimed_channel_id)
      VALUES (?, ?, ?, ?, NULL, NULL)
    `).run(userId, token, expiresAt, now);

    return Number(result.lastInsertRowid);
  }

  listActiveTelegramLinkTokensForUser(userId: number): TelegramLinkTokenRecord[] {
    return this.db.prepare(`
      SELECT
        id,
        user_id AS userId,
        token,
        expires_at AS expiresAt,
        created_at AS createdAt
      FROM telegram_link_tokens
      WHERE user_id = ? AND claimed_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC, id DESC
    `).all(userId, utcNow()) as TelegramLinkTokenRecord[];
  }

  consumeTelegramLinkToken(token: string, chatId: string, displayName?: string | null): number | null {
    const normalizedToken = token.trim();
    const normalizedChatId = chatId.trim();
    const normalizedDisplayName = displayName?.trim() || null;
    const consume = this.db.transaction(() => {
      const linkRow = this.db.prepare(`
        SELECT id, user_id AS userId
        FROM telegram_link_tokens
        WHERE token = ? AND claimed_at IS NULL AND expires_at > ?
        ORDER BY id DESC
        LIMIT 1
      `).get(normalizedToken, utcNow()) as { id: number; userId: number } | undefined;

      if (!linkRow) {
        return null;
      }

      const channelId = this.createNotificationChannel(linkRow.userId, "telegram", normalizedChatId, normalizedDisplayName, utcNow());
      this.db.prepare(`
        UPDATE telegram_link_tokens
        SET claimed_at = ?, claimed_channel_id = ?
        WHERE id = ?
      `).run(utcNow(), channelId, linkRow.id);

      return channelId;
    });

    return consume();
  }

  createEmailVerificationToken(channelId: number, token: string, expiresAt: string): number {
    const result = this.db.prepare(`
      INSERT INTO email_verification_tokens (channel_id, token, expires_at, created_at, used_at)
      VALUES (?, ?, ?, ?, NULL)
    `).run(channelId, token, expiresAt, utcNow());

    return Number(result.lastInsertRowid);
  }

  getLatestPendingEmailVerificationToken(channelId: number): EmailVerificationTokenRecord | null {
    const row = this.db.prepare(`
      SELECT
        id,
        channel_id AS channelId,
        token,
        expires_at AS expiresAt,
        created_at AS createdAt
      FROM email_verification_tokens
      WHERE channel_id = ? AND used_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(channelId, utcNow()) as EmailVerificationTokenRecord | undefined;

    return row ?? null;
  }

  createUserEmailVerificationToken(userId: number, token: string, expiresAt: string): number {
    const result = this.db.prepare(`
      INSERT INTO user_email_verification_tokens (user_id, token, expires_at, created_at, used_at)
      VALUES (?, ?, ?, ?, NULL)
    `).run(userId, token, expiresAt, utcNow());

    return Number(result.lastInsertRowid);
  }

  getLatestPendingUserEmailVerificationToken(userId: number): UserEmailVerificationTokenRecord | null {
    const row = this.db.prepare(`
      SELECT
        id,
        user_id AS userId,
        token,
        expires_at AS expiresAt,
        created_at AS createdAt
      FROM user_email_verification_tokens
      WHERE user_id = ? AND used_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(userId, utcNow()) as UserEmailVerificationTokenRecord | undefined;

    return row ?? null;
  }

  consumeUserEmailVerificationToken(token: string): UserRecord | null {
    const consume = this.db.transaction(() => {
      type UserVerificationRow = Omit<UserRecord, "isActive"> & {
        isActive: number;
        tokenId: number;
      };

      const row = this.db.prepare(`
        SELECT
          user_email_verification_tokens.id AS tokenId,
          users.id,
          users.first_name AS firstName,
          users.last_name AS lastName,
          users.email,
          users.password_hash AS passwordHash,
          users.role,
          users.is_active AS isActive,
          users.email_verified_at AS emailVerifiedAt,
          users.created_at AS createdAt
        FROM user_email_verification_tokens
        JOIN users ON users.id = user_email_verification_tokens.user_id
        WHERE user_email_verification_tokens.token = ?
          AND user_email_verification_tokens.used_at IS NULL
          AND user_email_verification_tokens.expires_at > ?
        LIMIT 1
      `).get(token.trim(), utcNow()) as UserVerificationRow | undefined;

      if (!row) {
        return null;
      }

      const now = utcNow();
      this.markUserEmailVerified(row.id, now);
      this.db.prepare(`
        UPDATE notification_channels
        SET verified_at = COALESCE(verified_at, ?), enabled = 1
        WHERE user_id = ? AND type = 'email' AND target = ?
      `).run(now, row.id, row.email);
      this.db.prepare(`
        UPDATE user_email_verification_tokens
        SET used_at = ?
        WHERE id = ?
      `).run(now, row.tokenId);

      return {
        ...row,
        isActive: Boolean(row.isActive),
        emailVerifiedAt: now
      };
    });

    return consume();
  }

  consumeEmailVerificationToken(token: string): NotificationChannelRecord | null {
    const consume = this.db.transaction(() => {
      type EmailVerificationRow = Omit<NotificationChannelRecord, "enabled"> & {
        enabled: number;
        tokenId: number;
      };

      const row = this.db.prepare(`
        SELECT
          email_verification_tokens.id AS tokenId,
          notification_channels.id,
          notification_channels.user_id AS userId,
          notification_channels.type,
          notification_channels.target,
          notification_channels.display_name AS displayName,
          notification_channels.enabled,
          notification_channels.verified_at AS verifiedAt,
          notification_channels.created_at AS createdAt
        FROM email_verification_tokens
        JOIN notification_channels ON notification_channels.id = email_verification_tokens.channel_id
        WHERE email_verification_tokens.token = ?
          AND email_verification_tokens.used_at IS NULL
          AND email_verification_tokens.expires_at > ?
        LIMIT 1
      `).get(token.trim(), utcNow()) as EmailVerificationRow | undefined;

      if (!row) {
        return null;
      }

      const now = utcNow();
      this.db.prepare(`
        UPDATE notification_channels
        SET verified_at = ?, enabled = 1
        WHERE id = ?
      `).run(now, row.id);

      this.db.prepare(`
        UPDATE email_verification_tokens
        SET used_at = ?
        WHERE id = ?
      `).run(now, row.tokenId);

      return {
        ...row,
        enabled: true,
        verifiedAt: now
      };
    });

    return consume();
  }

  insertAlertDelivery(input: Omit<AlertDeliveryRecord, "id" | "createdAt">): void {
    this.db.prepare(`
      INSERT INTO alert_deliveries (tracked_item_id, channel_id, event_type, status, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.trackedItemId, input.channelId, input.eventType, input.status, input.detail ?? null, utcNow());
  }

  listUsersWithCounts(): UserWithCounts[] {
    const rows = this.db.prepare(`
      SELECT
        users.id,
        users.first_name AS firstName,
        users.last_name AS lastName,
        users.email,
        users.role,
        users.is_active AS isActive,
        users.email_verified_at AS emailVerifiedAt,
        users.created_at AS createdAt,
        COUNT(DISTINCT tracked_items.id) AS trackedItemCount,
        COUNT(DISTINCT notification_channels.id) AS channelCount
      FROM users
      LEFT JOIN tracked_items ON tracked_items.owner_user_id = users.id
      LEFT JOIN notification_channels ON notification_channels.user_id = users.id
      GROUP BY users.id
      ORDER BY users.created_at DESC, users.id DESC
    `).all() as Array<Omit<UserWithCounts, "isActive"> & { isActive: number }>;

    return rows.map((row) => ({
      ...row,
      isActive: Boolean(row.isActive)
    }));
  }

  listPlatformTrackedItems(): PlatformTrackedItem[] {
    return this.db.prepare(`
      SELECT
        tracked_items.id,
        tracked_items.owner_user_id AS ownerUserId,
        users.email AS ownerEmail,
        tracked_items.name,
        tracked_items.url,
        tracked_items.enabled,
        tracked_items.archived_at AS archivedAt,
        latest.price AS latestPrice,
        latest.status AS latestStatus,
        latest.checked_at AS latestCheckedAt
      FROM tracked_items
      JOIN users ON users.id = tracked_items.owner_user_id
      LEFT JOIN (
        SELECT price_checks.*
        FROM price_checks
        JOIN (
          SELECT tracked_item_id, MAX(id) AS max_id
          FROM price_checks
          GROUP BY tracked_item_id
        ) latest_ids ON latest_ids.max_id = price_checks.id
      ) latest ON latest.tracked_item_id = tracked_items.id
      WHERE tracked_items.archived_at IS NULL
      ORDER BY tracked_items.created_at DESC, tracked_items.id DESC
    `).all() as PlatformTrackedItem[];
  }
}
