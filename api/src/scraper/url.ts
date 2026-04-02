import dns from "node:dns/promises";
import net from "node:net";

function isBlockedIpAddress(ip: string): boolean {
  if (net.isIP(ip) === 4) {
    if (ip === "127.0.0.1" || ip === "0.0.0.0") return true;
    if (ip.startsWith("10.")) return true;
    if (ip.startsWith("192.168.")) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
    if (ip.startsWith("169.254.")) return true;
    if (ip === "100.100.100.200") return true;
    return false;
  }

  if (net.isIP(ip) === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === "::1" || normalized === "::") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    if (normalized.startsWith("fe80:")) return true;
    if (normalized.startsWith("::ffff:127.")) return true;
    if (normalized.startsWith("::ffff:10.")) return true;
    if (normalized.startsWith("::ffff:192.168.")) return true;
    if (/^::ffff:172\.(1[6-9]|2\d|3[0-1])\./.test(normalized)) return true;
    if (normalized.startsWith("::ffff:169.254.")) return true;
    return false;
  }

  return true;
}

export async function validateScrapeUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http and https URLs are allowed.");
  }

  const hostname = parsed.hostname.trim().toLowerCase();
  if (!hostname) {
    throw new Error("Invalid URL hostname.");
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Private or local network targets are not allowed.");
  }

  if (net.isIP(hostname)) {
    if (isBlockedIpAddress(hostname)) {
      throw new Error("Private or local network targets are not allowed.");
    }
    return parsed;
  }

  const records = await dns.lookup(hostname, { all: true });
  if (records.length === 0 || records.some((record) => isBlockedIpAddress(record.address))) {
    throw new Error("Private or local network targets are not allowed.");
  }

  return parsed;
}
