export type User = {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  role: "user" | "admin";
  emailVerifiedAt: string | null;
  acceptLanguage: string | null;
  browserLocale: string | null;
  browserTimezone: string | null;
  createdAt: string;
};

export type DetectionResult = {
  name: string;
  pageTitle: string | null;
  url: string;
  currency: string;
  detectionSource: string;
  previewRawText: string;
  previewPrice: string;
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

export type TrackedItemWithHistory = {
  id: number;
  ownerUserId: number;
  name: string;
  pageTitle: string | null;
  url: string;
  currency: string;
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
  latestCheck: PriceCheckRecord | null;
  lowestPrice: string | null;
  history: PriceCheckRecord[];
};

export type NotificationChannelRecord = {
  id: number;
  userId: number;
  type: "email" | "telegram";
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

export type UserWithCounts = {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  role: "user" | "admin";
  isActive: boolean;
  emailVerifiedAt: string | null;
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

export type TrackerStatus = {
  running: boolean;
  lastRunAt: string | null;
};

export type ScrapeDebugResult = {
  inputUrl: string;
  finalUrl: string | null;
  fetchMode: "http" | "browser" | "regional-http" | "regional-browser" | null;
  pageTitle: string | null;
  blockedMessage: string | null;
  errorMessage: string | null;
  html: string | null;
  htmlBytes: number | null;
  scrapePreferences: {
    acceptLanguage: string | null;
    browserLocale: string | null;
    browserTimezone: string | null;
  } | null;
  inferredRegion: string | null;
  requestHeaders: Record<string, string>;
  browserFallbackSuggested: boolean | null;
  detection: {
    name: string;
    pageTitle: string | null;
    url: string;
    currency: string;
    detectionSource: string;
    previewRawText: string;
    previewPrice: string;
  } | null;
  events: Array<{
    step: string;
    detail: string;
  }>;
};
