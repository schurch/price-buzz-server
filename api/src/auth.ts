import crypto from "node:crypto";

const SESSION_DURATION_DAYS = 30;

function sessionExpiryDate(): Date {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + SESSION_DURATION_DAYS);
  return expiresAt;
}

export function createSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function createPasswordHash(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, passwordHash: string): boolean {
  const [salt, stored] = passwordHash.split(":");
  if (!salt || !stored) {
    return false;
  }

  const candidate = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(stored, "hex"), Buffer.from(candidate, "hex"));
}

export function buildSessionExpiry(): string {
  return sessionExpiryDate().toISOString();
}
