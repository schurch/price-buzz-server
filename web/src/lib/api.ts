import type {
  DetectionResult,
  NotificationChannelRecord,
  PlatformTrackedItem,
  ScrapeDebugResult,
  TelegramLinkTokenRecord,
  TrackerStatus,
  TrackedItemWithHistory,
  User,
  UserWithCounts
} from "./types";

const API_BASE = (window as Window & { __PRICEBUZZ_ENV__?: { apiBase?: string } }).__PRICEBUZZ_ENV__?.apiBase ?? "/api";

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  if (init?.body !== undefined && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "same-origin",
    headers,
    ...init
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  const payload = text ? JSON.parse(text) as unknown : {};
  if (!response.ok) {
    const message = typeof payload === "object" && payload && "error" in payload && typeof (payload as { error?: unknown }).error === "string"
      ? (payload as { error: string }).error
      : `Request failed with ${response.status}`;
    throw new ApiError(message, response.status);
  }

  return payload as T;
}

export function getSession(): Promise<{ authenticated: boolean; user: User | null }> {
  return request("/session");
}

export function signup(input: {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  acceptLanguage?: string | null;
  browserLocale?: string | null;
  browserTimezone?: string | null;
}): Promise<{ user: User; notice: string }> {
  return request("/auth/signup", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function login(input: {
  email: string;
  password: string;
  acceptLanguage?: string | null;
  browserLocale?: string | null;
  browserTimezone?: string | null;
}): Promise<{ user: User; notice: string }> {
  return request("/auth/login", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function logout(): Promise<void> {
  return request("/auth/logout", { method: "POST" });
}

export function getDashboard(): Promise<{
  user: User;
  items: TrackedItemWithHistory[];
}> {
  return request("/dashboard");
}

export function detectItem(input: {
  url: string;
  acceptLanguage?: string | null;
  browserLocale?: string | null;
  browserTimezone?: string | null;
}): Promise<{ detection: DetectionResult }> {
  return request("/items/detect", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function createItem(input: Record<string, string | null>): Promise<{
  trackedItemId: number;
  notice: string;
  dashboard: {
    user: User;
    items: TrackedItemWithHistory[];
  };
}> {
  return request("/items", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function deleteItem(id: number): Promise<{
  notice: string;
  dashboard: {
    user: User;
    items: TrackedItemWithHistory[];
  };
}> {
  return request(`/items/${id}`, { method: "DELETE" });
}

export function runChecks(): Promise<{
  notice: string;
  runSummary: {
    checked: number;
    successes: number;
    errors: number;
    items: Array<{
      trackedItemId: number;
      name: string;
      url: string;
      status: "ok" | "error";
      checkedAt: string;
      price: string | null;
      currency: string | null;
      errorMessage: string | null;
    }>;
  };
  admin: {
    user: User;
    users: UserWithCounts[];
    items: PlatformTrackedItem[];
    tracker: TrackerStatus;
  };
}> {
  return request("/checks/run", { method: "POST" });
}

export function getSettings(): Promise<{
  user: User;
  channels: NotificationChannelRecord[];
  telegramLinks: TelegramLinkTokenRecord[];
  telegramBotUsername: string | null;
}> {
  return request("/settings");
}

export function resendVerification(): Promise<{ notice: string }> {
  return request("/settings/email-verification/resend", { method: "POST" });
}

export function createTelegramLink(): Promise<{
  notice: string;
  settings: {
    user: User;
    channels: NotificationChannelRecord[];
    telegramLinks: TelegramLinkTokenRecord[];
    telegramBotUsername: string | null;
  };
}> {
  return request("/settings/notifications/telegram-links", { method: "POST" });
}

export function getAdmin(): Promise<{
  user: User;
  users: UserWithCounts[];
  items: PlatformTrackedItem[];
  tracker: TrackerStatus;
}> {
  return request("/admin");
}

export function updateAdminUser(
  id: number,
  input: {
    firstName: string;
    lastName: string;
    email: string;
    role: "user" | "admin";
    isActive: boolean;
  }
): Promise<{
  notice: string;
  admin: {
    user: User;
    users: UserWithCounts[];
    items: PlatformTrackedItem[];
    tracker: TrackerStatus;
  };
}> {
  return request(`/admin/users/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function deleteAdminUser(id: number): Promise<{
  notice: string;
  admin: {
    user: User;
    users: UserWithCounts[];
    items: PlatformTrackedItem[];
    tracker: TrackerStatus;
  };
}> {
  return request(`/admin/users/${id}`, { method: "DELETE" });
}

export function updateAdminItem(
  id: number,
  input: {
    name: string;
    url: string;
    enabled: boolean;
  }
): Promise<{
  notice: string;
  admin: {
    user: User;
    users: UserWithCounts[];
    items: PlatformTrackedItem[];
    tracker: TrackerStatus;
  };
}> {
  return request(`/admin/items/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function deleteAdminItem(id: number): Promise<{
  notice: string;
  admin: {
    user: User;
    users: UserWithCounts[];
    items: PlatformTrackedItem[];
    tracker: TrackerStatus;
  };
}> {
  return request(`/admin/items/${id}`, { method: "DELETE" });
}

export function sendAdminTestEmail(targets: string): Promise<{ notice: string }> {
  return request("/admin/test/email", {
    method: "POST",
    body: JSON.stringify({ targets })
  });
}

export function sendAdminTestTelegram(targets: string): Promise<{ notice: string }> {
  return request("/admin/test/telegram", {
    method: "POST",
    body: JSON.stringify({ targets })
  });
}

export function scrapeDebug(input: {
  url: string;
  acceptLanguage?: string | null;
  browserLocale?: string | null;
  browserTimezone?: string | null;
}): Promise<{
  notice: string | null;
  error: string | null;
  scrapeDebug: ScrapeDebugResult;
}> {
  return request("/admin/scrape-debug", {
    method: "POST",
    body: JSON.stringify(input)
  });
}
