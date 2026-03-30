export type UserRole = "user" | "admin";

export type ScrapePreferences = {
  acceptLanguage: string | null;
  browserLocale: string | null;
  browserTimezone: string | null;
};

export type UserRecord = {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  isActive: boolean;
  emailVerifiedAt: string | null;
  acceptLanguage: string | null;
  browserLocale: string | null;
  browserTimezone: string | null;
  createdAt: string;
};

export type SessionRecord = {
  id: string;
  userId: number;
  expiresAt: string;
};

export type TrackedItemRecord = {
  id: number;
  ownerUserId: number;
  name: string;
  pageTitle: string | null;
  url: string;
  selector: string | null;
  currency: string;
  attribute: string | null;
  regex: string | null;
  htmlRegex: string | null;
  headersJson: string | null;
  detectionSource: string | null;
  initialDetectedPrice: string | null;
  initialDetectedCurrency: string | null;
  initialDetectedRawText: string | null;
  firstDetectedAt: string | null;
  enabled: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PriceCheckRecord = {
  id: number;
  trackedItemId: number;
  status: "ok" | "error";
  checkedAt: string;
  price: string | null;
  currency: string | null;
  rawText: string | null;
  errorMessage: string | null;
};

export type NotificationChannelType = "email" | "telegram";

export type NotificationChannelRecord = {
  id: number;
  userId: number;
  type: NotificationChannelType;
  target: string;
  displayName: string | null;
  enabled: boolean;
  verifiedAt: string | null;
  createdAt: string;
};

export type TelegramLinkTokenRecord = {
  id: number;
  userId: number;
  token: string;
  expiresAt: string;
  createdAt: string;
};

export type EmailVerificationTokenRecord = {
  id: number;
  channelId: number;
  token: string;
  expiresAt: string;
  createdAt: string;
};

export type UserEmailVerificationTokenRecord = {
  id: number;
  userId: number;
  token: string;
  expiresAt: string;
  createdAt: string;
};

export type AlertDeliveryRecord = {
  id: number;
  trackedItemId: number;
  channelId: number;
  eventType: string;
  status: "sent" | "failed";
  detail: string | null;
  createdAt: string;
};

export type TrackedItemInput = {
  ownerUserId: number;
  name: string;
  pageTitle?: string | null;
  url: string;
  selector?: string | null;
  currency?: string;
  attribute?: string | null;
  regex?: string | null;
  htmlRegex?: string | null;
  headers?: Record<string, string> | null;
  detectionSource?: string | null;
  initialDetectedPrice?: string | null;
  initialDetectedCurrency?: string | null;
  initialDetectedRawText?: string | null;
  firstDetectedAt?: string | null;
  enabled?: boolean;
};

export type TrackedItemWithHistory = TrackedItemRecord & {
  latestCheck: PriceCheckRecord | null;
  lowestPrice: string | null;
  history: PriceCheckRecord[];
};

export type UserWithCounts = {
  id: number;
  email: string;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
  trackedItemCount: number;
  channelCount: number;
};

export type PlatformTrackedItem = {
  id: number;
  ownerUserId: number;
  ownerEmail: string;
  name: string;
  url: string;
  enabled: boolean;
  latestPrice: string | null;
  latestStatus: string | null;
  latestCheckedAt: string | null;
};

export type DetectionResult = {
  name: string;
  pageTitle: string | null;
  url: string;
  selector: string | null;
  currency: string;
  attribute: string | null;
  regex: string | null;
  htmlRegex: string | null;
  detectionSource: string;
  previewRawText: string;
  previewPrice: string;
};

export type ScrapeDebugResult = {
  inputUrl: string;
  finalUrl: string | null;
  fetchMode: "http" | "browser" | null;
  pageTitle: string | null;
  blockedMessage: string | null;
  errorMessage: string | null;
  html: string | null;
  htmlBytes: number | null;
};
