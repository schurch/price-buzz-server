import { escapeHtml, formatPrice, formatTimestamp } from "./utils.js";
import type {
  DetectionResult,
  NotificationChannelRecord,
  PlatformTrackedItem,
  TelegramLinkTokenRecord,
  TrackedItemWithHistory,
  UserRecord,
  UserWithCounts
} from "./types.js";

function renderSparkline(item: TrackedItemWithHistory): string {
  const points = [...item.history]
    .filter((entry) => entry.status === "ok" && entry.price)
    .reverse()
    .map((entry) => Number.parseFloat(entry.price ?? ""))
    .filter((value) => Number.isFinite(value));

  if (points.length === 0) {
    return '<div class="sparkline-empty">No price history yet.</div>';
  }

  if (points.length === 1) {
    points.push(points[0]);
  }

  const width = 240;
  const height = 78;
  const padding = 6;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;

  const linePoints = points.map((value, index) => {
    const x = padding + (index * (width - padding * 2)) / (points.length - 1);
    const normalized = (value - min) / range;
    const y = height - padding - normalized * (height - padding * 2);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const areaPoints = [
    `${padding},${height - padding}`,
    ...linePoints,
    `${width - padding},${height - padding}`
  ].join(" ");

  return `
    <div class="sparkline">
      <div class="sparkline-meta">
        <span>Trend</span>
        <span>${escapeHtml(formatPrice(min.toFixed(2), item.currency))} to ${escapeHtml(formatPrice(max.toFixed(2), item.currency))}</span>
      </div>
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
        <polygon points="${areaPoints}" class="sparkline-fill"></polygon>
        <polyline points="${linePoints.join(" ")}" class="sparkline-line"></polyline>
      </svg>
    </div>
  `;
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll("\n", " ");
}

function renderBrowserContextFields(): string {
  return `
    <input type="hidden" name="acceptLanguage" data-browser-context="accept-language">
    <input type="hidden" name="browserLocale" data-browser-context="browser-locale">
    <input type="hidden" name="browserTimezone" data-browser-context="browser-timezone">
  `;
}

function siteLabel(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "");
  } catch {
    return rawUrl;
  }
}

function userDisplayName(user: UserRecord): string {
  const fullName = `${user.firstName} ${user.lastName}`.trim();
  return fullName || user.email;
}

function userFullName(user: UserRecord): string | null {
  const fullName = `${user.firstName} ${user.lastName}`.trim();
  return fullName || null;
}

function renderShell(input: {
  title: string;
  bodyClass?: string;
  heading?: string;
  subheading?: string;
  nav?: string;
  content: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f3f3fb;
      --panel: rgba(255, 255, 255, 0.9);
      --ink: #171723;
      --muted: #67657d;
      --border: rgba(104, 92, 178, 0.16);
      --accent: #6f5cff;
      --accent-soft: rgba(111, 92, 255, 0.12);
      --shadow: 0 18px 40px rgba(42, 34, 99, 0.12);
      --good: #176c52;
      --bad: #ab3f2e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(111, 92, 255, 0.13), transparent 24rem),
        linear-gradient(180deg, #ffffff, var(--bg));
    }
    a { color: inherit; }
    main {
      width: min(1180px, calc(100vw - 2rem));
      margin: 0 auto;
      padding: 1.5rem 0 3rem;
    }
    .hero, .panel, .card, .stat, .auth-box {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 20px;
      box-shadow: var(--shadow);
    }
    .hero {
      padding: 1.5rem;
    }
    .hero h1 {
      margin: 0;
      font-size: clamp(2rem, 4vw, 3.4rem);
      line-height: 0.95;
      letter-spacing: -0.04em;
    }
    .hero p {
      color: var(--muted);
      max-width: 48rem;
      line-height: 1.55;
    }
    .app-shell {
      background:
        radial-gradient(circle at 0% 0%, rgba(255, 255, 255, 0.8), transparent 18rem),
        radial-gradient(circle at 100% 0%, rgba(111, 92, 255, 0.09), transparent 18rem),
        linear-gradient(180deg, #ffffff 0%, #f4f4fd 100%);
    }
    .app-main {
      width: min(1240px, calc(100vw - 2rem));
      padding-top: 1rem;
    }
    .app-nav {
      position: sticky;
      top: 0.75rem;
      z-index: 10;
      padding: 0.7rem 0.85rem;
      border-radius: 22px;
      background: rgba(255, 255, 255, 0.82);
      border: 1px solid rgba(104, 92, 178, 0.12);
      box-shadow: 0 12px 28px rgba(42, 34, 99, 0.08);
      backdrop-filter: blur(18px);
    }
    .app-nav .pill {
      background: transparent;
    }
    .app-hero {
      margin-top: 1rem;
      padding: 1.2rem 1.25rem;
      border-radius: 28px;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.78), rgba(255,255,255,0.62)),
        radial-gradient(circle at top right, rgba(111, 92, 255, 0.1), transparent 15rem);
      border: 1px solid rgba(104, 92, 178, 0.11);
      box-shadow: 0 16px 34px rgba(42, 34, 99, 0.08);
    }
    .app-hero h1 {
      font-size: clamp(2rem, 4vw, 3.2rem);
      letter-spacing: -0.05em;
    }
    .app-hero p {
      max-width: 42rem;
      font-size: 0.98rem;
      line-height: 1.6;
      margin-top: 0.7rem;
    }
    .app-section {
      margin-top: 1rem;
    }
    .app-stats {
      gap: 0.85rem;
    }
    .app-stat {
      padding: 0.95rem;
      border-radius: 18px;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.82), rgba(255,255,255,0.62));
      border: 1px solid rgba(104, 92, 178, 0.1);
      box-shadow: 0 12px 26px rgba(42, 34, 99, 0.06);
    }
    .app-grid {
      gap: 0.85rem;
    }
    .app-grid .card,
    .app-grid .panel,
    .app-panel,
    .app-auth-box {
      border-radius: 24px;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.84), rgba(255,255,255,0.68));
      border: 1px solid rgba(104, 92, 178, 0.1);
      box-shadow: 0 14px 30px rgba(42, 34, 99, 0.07);
    }
    .app-grid .card h2,
    .app-panel h2,
    .app-auth-box h2 {
      font-size: 1rem;
      letter-spacing: -0.02em;
      margin-bottom: 0.5rem;
    }
    .compact-table th,
    .compact-table td {
      padding: 0.6rem 0;
      font-size: 0.89rem;
    }
    .card-actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.75rem;
      margin-top: 1rem;
    }
    .subtle-button {
      background: rgba(255,255,255,0.78);
      border: 1px solid rgba(104, 92, 178, 0.12);
      color: var(--ink);
    }
    .marketing-shell {
      background:
        radial-gradient(circle at 20% 0%, rgba(255, 255, 255, 0.9), transparent 28rem),
        radial-gradient(circle at 80% 10%, rgba(111, 92, 255, 0.14), transparent 22rem),
        linear-gradient(180deg, #ffffff 0%, #f5f3ff 40%, #f3f3fb 100%);
    }
    .marketing-main {
      width: min(1320px, calc(100vw - 2rem));
      padding-top: 0.8rem;
    }
    .marketing-nav {
      position: sticky;
      top: 0.75rem;
      z-index: 10;
      padding: 0.75rem 1rem;
      backdrop-filter: blur(18px);
      background: rgba(255, 255, 255, 0.78);
      border: 1px solid rgba(104, 92, 178, 0.12);
      border-radius: 999px;
      box-shadow: 0 10px 30px rgba(42, 34, 99, 0.08);
    }
    .marketing-nav .brand {
      font-size: 0.92rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      font-weight: 700;
    }
    .marketing-hero {
      min-height: 78vh;
      display: grid;
      align-items: center;
      padding: 2rem 0 1rem;
    }
    .marketing-hero h1 {
      font-size: clamp(3.4rem, 10vw, 8.4rem);
      line-height: 0.9;
      letter-spacing: -0.07em;
      max-width: 10ch;
    }
    .marketing-lead {
      max-width: 46rem;
      font-size: clamp(1.05rem, 1.6vw, 1.3rem);
      line-height: 1.65;
      color: #4d4339;
      margin-top: 1.5rem;
    }
    .marketing-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.85rem;
      margin-top: 1.8rem;
    }
    .eyebrow {
      display: inline-block;
      margin-bottom: 1rem;
      padding: 0.45rem 0.8rem;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.72);
      border: 1px solid rgba(104, 92, 178, 0.12);
      color: #7068a8;
      font-size: 0.78rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      font-weight: 700;
    }
    .marketing-stage {
      margin-top: 1.4rem;
      border-radius: 36px;
      overflow: hidden;
      background:
        linear-gradient(135deg, rgba(255,255,255,0.9), rgba(243, 240, 255, 0.86)),
        radial-gradient(circle at top right, rgba(111, 92, 255, 0.16), transparent 16rem);
      border: 1px solid rgba(104, 92, 178, 0.1);
      box-shadow: 0 28px 60px rgba(42, 34, 99, 0.14);
      padding: clamp(1.4rem, 3vw, 2.4rem);
    }
    .hero-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(320px, 0.9fr);
      gap: 1.2rem;
      align-items: center;
    }
    .hero-copy {
      min-width: 0;
    }
    .hero-copy h2 {
      margin: 0;
      font-size: clamp(2rem, 3.5vw, 3.8rem);
      line-height: 0.95;
      letter-spacing: -0.05em;
      max-width: 11ch;
    }
    .hero-copy p {
      margin: 0.9rem 0 0;
      max-width: 34rem;
      color: var(--muted);
      line-height: 1.65;
      font-size: 1rem;
    }
    .hero-points {
      display: grid;
      gap: 0.75rem;
      margin-top: 1.35rem;
    }
    .hero-point {
      display: flex;
      gap: 0.7rem;
      align-items: flex-start;
      color: var(--ink);
    }
    .hero-point::before {
      content: "";
      width: 10px;
      height: 10px;
      margin-top: 0.38rem;
      border-radius: 50%;
      background: linear-gradient(180deg, #7c8fff, #5f73ff);
      box-shadow: 0 0 0 6px rgba(95, 115, 255, 0.08);
      flex: 0 0 auto;
    }
    .hero-board {
      min-height: 420px;
      border-radius: 30px;
      padding: 1.25rem;
      display: grid;
      gap: 0.95rem;
      align-content: start;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.82), rgba(242, 245, 255, 0.94)),
        radial-gradient(circle at top right, rgba(95, 115, 255, 0.14), transparent 14rem);
      border: 1px solid rgba(104, 92, 178, 0.1);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.85);
      overflow: hidden;
    }
    .hero-chart {
      position: relative;
      min-height: 220px;
      padding: 0.75rem;
      border-radius: 22px;
      background:
        linear-gradient(180deg, rgba(95, 115, 255, 0.08), rgba(255,255,255,0.4)),
        linear-gradient(90deg, rgba(94, 124, 255, 0.06) 1px, transparent 1px),
        linear-gradient(180deg, rgba(94, 124, 255, 0.06) 1px, transparent 1px);
      background-size: auto, 40px 100%, 100% 34px;
    }
    .hero-chart svg {
      display: block;
      width: 100%;
      height: 220px;
    }
    .hero-chart-area {
      fill: rgba(95, 115, 255, 0.08);
    }
    .hero-chart-line {
      fill: none;
      stroke: rgba(95, 115, 255, 0.58);
      stroke-width: 4;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .hero-chart-point {
      fill: rgba(95, 115, 255, 0.72);
      stroke: rgba(255,255,255,0.95);
      stroke-width: 4;
    }
    .hero-metrics {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 0.85rem;
    }
    .hero-metric {
      padding: 0.9rem 1rem;
      border-radius: 18px;
      background: rgba(255,255,255,0.78);
      border: 1px solid rgba(104, 92, 178, 0.1);
      backdrop-filter: blur(8px);
    }
    .hero-metric small {
      display: block;
      color: var(--muted);
      font-size: 0.76rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      font-weight: 700;
    }
    .hero-metric strong {
      display: block;
      margin-top: 0.35rem;
      font-size: 1.7rem;
      line-height: 1;
      letter-spacing: -0.05em;
    }
    .hero-caption {
      padding: 1rem 1.1rem;
      border-radius: 18px;
      background: rgba(255,255,255,0.78);
      border: 1px solid rgba(104, 92, 178, 0.1);
      backdrop-filter: blur(8px);
    }
    .hero-caption p {
      margin: 0;
      color: var(--muted);
      line-height: 1.5;
      max-width: 32ch;
    }
    .marketing-section {
      margin-top: 4.5rem;
    }
    .marketing-section h2 {
      margin: 0;
      font-size: clamp(2rem, 5vw, 4.6rem);
      letter-spacing: -0.05em;
      line-height: 0.95;
      max-width: 9ch;
    }
    .marketing-section > p {
      max-width: 44rem;
      color: var(--muted);
      line-height: 1.65;
      font-size: 1.05rem;
      margin-top: 1rem;
    }
    .marketing-features {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 1rem;
      margin-top: 1.4rem;
    }
    .feature-panel {
      min-height: 260px;
      padding: 1.2rem;
      border-radius: 30px;
      background: rgba(255, 255, 255, 0.74);
      border: 1px solid rgba(104, 92, 178, 0.12);
      box-shadow: 0 18px 40px rgba(42, 34, 99, 0.08);
    }
    .feature-art {
      display: grid;
      place-items: center;
      height: 122px;
      margin-bottom: 1rem;
      border-radius: 22px;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.84), rgba(245, 247, 255, 0.94)),
        radial-gradient(circle at top right, rgba(95, 115, 255, 0.08), transparent 10rem);
      border: 1px solid rgba(95, 115, 255, 0.1);
      overflow: hidden;
    }
    .feature-art svg {
      width: 100%;
      height: 100%;
      display: block;
    }
    .feature-panel strong {
      display: block;
      font-size: 1.4rem;
      letter-spacing: -0.03em;
      margin-top: 0.7rem;
    }
    .feature-panel p {
      color: var(--muted);
      line-height: 1.6;
      margin-top: 0.75rem;
    }
    .marketing-cta {
      margin-top: 4.5rem;
      padding: 2rem;
      border-radius: 36px;
      background:
        linear-gradient(135deg, rgba(255,255,255,0.92), rgba(244, 241, 255, 0.86)),
        radial-gradient(circle at bottom right, rgba(111, 92, 255, 0.14), transparent 18rem);
      border: 1px solid rgba(104, 92, 178, 0.1);
      box-shadow: 0 28px 60px rgba(42, 34, 99, 0.1);
    }
    .marketing-cta h2 {
      max-width: none;
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1rem;
      flex-wrap: wrap;
    }
    .topbar nav, .actions {
      display: flex;
      gap: 0.75rem;
      flex-wrap: wrap;
      align-items: center;
    }
    .pill, button, .button-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      padding: 0.75rem 1rem;
      text-decoration: none;
      font: inherit;
      font-weight: 700;
    }
    .pill, .button-link.secondary, button.secondary {
      background: white;
      border: 1px solid var(--border);
      color: var(--ink);
    }
    .button-link.primary, button {
      background: var(--accent);
      color: white;
      border: 0;
    }
    .stats, .grid, .forms {
      display: grid;
      gap: 1rem;
    }
    .stats {
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      margin-top: 1rem;
    }
    .stat {
      padding: 1rem;
    }
    .stat small {
      display: block;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 700;
      font-size: 0.72rem;
    }
    .stat strong {
      display: block;
      margin-top: 0.35rem;
      font-size: 1.2rem;
    }
    .grid {
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    }
    .card, .panel, .auth-box {
      padding: 1rem;
      min-width: 0;
    }
    .tracked-item-card {
      display: flex;
      flex-direction: column;
      min-height: 100%;
    }
    .card h2, .panel h2, .auth-box h2 {
      margin: 0 0 0.6rem;
      font-size: 1.1rem;
      line-height: 1.3;
    }
    .tracked-item-card h2 {
      min-height: 2.8em;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .site-badge {
      align-self: flex-start;
      margin-bottom: 0.6rem;
      padding: 0.38rem 0.62rem;
      border-radius: 999px;
      background: rgba(111, 92, 255, 0.08);
      color: #5f56a3;
      font-size: 0.76rem;
      font-weight: 700;
      letter-spacing: 0.04em;
    }
    .tracked-item-subtitle {
      min-height: 2.8em;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      margin: 0;
    }
    .tracked-item-url {
      min-height: 1.5em;
      margin: 0.55rem 0 0;
      font-size: 0.9rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .muted {
      color: var(--muted);
    }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 0.75rem;
      margin: 1rem 0;
    }
    .metric-grid dt {
      color: var(--muted);
      font-size: 0.8rem;
    }
    .metric-grid dd {
      margin: 0.2rem 0 0;
      font-size: 1rem;
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .item-toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
      align-items: end;
      margin-top: 1rem;
      padding: 1rem;
      border-radius: 22px;
      background: linear-gradient(180deg, rgba(255,255,255,0.82), rgba(255,255,255,0.68));
      border: 1px solid rgba(104, 92, 178, 0.1);
      box-shadow: 0 14px 30px rgba(42, 34, 99, 0.07);
    }
    .item-toolbar .field {
      display: grid;
      gap: 0.35rem;
      min-width: 180px;
      flex: 1 1 180px;
    }
    .item-toolbar label {
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      font-weight: 700;
    }
    .item-groups {
      display: grid;
      gap: 0.9rem;
      margin-top: 1rem;
    }
    .item-group {
      border-radius: 24px;
      background: linear-gradient(180deg, rgba(255,255,255,0.84), rgba(255,255,255,0.68));
      border: 1px solid rgba(104, 92, 178, 0.1);
      box-shadow: 0 14px 30px rgba(42, 34, 99, 0.07);
      padding: 0.25rem 1rem 1rem;
    }
    .item-group summary {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      padding: 1rem 0 0.8rem;
      list-style: none;
    }
    .item-group summary::-webkit-details-marker {
      display: none;
    }
    .item-group-title {
      font-size: 1rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .item-group-count {
      color: var(--muted);
      font-size: 0.85rem;
    }
    .item-group-grid {
      display: grid;
      gap: 0.85rem;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    }
    .sparkline {
      margin-top: 0.7rem;
      padding: 0.8rem;
      border-radius: 18px;
      background: linear-gradient(180deg, rgba(111, 92, 255, 0.08), rgba(255,255,255,0.5));
      border: 1px solid rgba(104, 92, 178, 0.08);
    }
    .sparkline-meta {
      display: flex;
      justify-content: space-between;
      gap: 0.75rem;
      color: var(--muted);
      font-size: 0.78rem;
      margin-bottom: 0.45rem;
    }
    .sparkline svg {
      display: block;
      width: 100%;
      height: 78px;
    }
    .sparkline-line {
      fill: none;
      stroke: var(--accent);
      stroke-width: 2.2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .sparkline-fill {
      fill: rgba(111, 92, 255, 0.14);
    }
    .sparkline-empty {
      color: var(--muted);
      font-size: 0.86rem;
    }
    .card-actions {
      margin-top: auto;
      padding-top: 1rem;
    }
    .hidden-source {
      display: none;
    }
    form {
      display: grid;
      gap: 0.75rem;
    }
    label {
      display: grid;
      gap: 0.35rem;
      font-size: 0.92rem;
    }
    input, select, textarea {
      width: 100%;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: white;
      padding: 0.8rem;
      font: inherit;
    }
    button {
      cursor: pointer;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.92rem;
    }
    th, td {
      text-align: left;
      padding: 0.7rem 0;
      border-top: 1px solid var(--border);
      vertical-align: top;
    }
    .auth-wrap {
      display: grid;
      place-items: center;
      min-height: 70vh;
    }
    .auth-box {
      width: min(440px, 100%);
    }
    .notice {
      padding: 0.8rem 0.9rem;
      border-radius: 14px;
      background: var(--accent-soft);
      color: var(--ink);
    }
    .error {
      color: var(--bad);
    }
    .good {
      color: var(--good);
    }
    .url {
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    details summary {
      cursor: pointer;
      font-weight: 700;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f1220;
        --panel: rgba(18, 22, 38, 0.88);
        --ink: #eef2ff;
        --muted: #a7b0cc;
        --border: rgba(138, 150, 255, 0.16);
        --accent: #7c8fff;
        --accent-soft: rgba(124, 143, 255, 0.16);
        --shadow: 0 18px 40px rgba(0, 0, 0, 0.32);
        --good: #68d3a5;
        --bad: #ff8e7d;
      }
      body {
        background:
          radial-gradient(circle at top left, rgba(124, 143, 255, 0.16), transparent 24rem),
          linear-gradient(180deg, #0b0f19, var(--bg));
      }
      .app-shell {
        background:
          radial-gradient(circle at 0% 0%, rgba(124, 143, 255, 0.08), transparent 18rem),
          radial-gradient(circle at 100% 0%, rgba(124, 143, 255, 0.12), transparent 18rem),
          linear-gradient(180deg, #0b0f19 0%, #111629 100%);
      }
      .marketing-shell {
        background:
          radial-gradient(circle at 20% 0%, rgba(124, 143, 255, 0.08), transparent 28rem),
          radial-gradient(circle at 80% 10%, rgba(124, 143, 255, 0.14), transparent 22rem),
          linear-gradient(180deg, #0b0f19 0%, #111629 40%, #101522 100%);
      }
      .app-nav,
      .marketing-nav,
      .app-hero,
      .app-stat,
      .app-grid .card,
      .app-grid .panel,
      .app-panel,
      .app-auth-box,
      .item-toolbar,
      .item-group,
      .sparkline,
      .marketing-stage,
      .hero-board,
      .feature-panel,
      .feature-art,
      .marketing-cta,
      .hero-metric,
      .hero-caption,
      .abstract-copy,
      .screen-photo,
      .auth-box,
      .hero,
      .panel,
      .card,
      .stat {
        background: rgba(18, 22, 38, 0.84);
        border-color: rgba(138, 150, 255, 0.14);
        box-shadow: 0 16px 34px rgba(0, 0, 0, 0.28);
      }
      .hero-board::before,
      .hero-chart,
      .screen-chart,
      .photo-abstract,
      .feature-art {
        background:
          linear-gradient(180deg, rgba(124, 143, 255, 0.08), rgba(17, 22, 41, 0.5)),
          linear-gradient(90deg, rgba(124, 143, 255, 0.08) 1px, transparent 1px),
          linear-gradient(180deg, rgba(124, 143, 255, 0.08) 1px, transparent 1px);
      }
      .hero-board::after,
      .screen-chart::after,
      .hero-chart-area,
      .sparkline-fill {
        opacity: 0.7;
      }
      input,
      select,
      textarea {
        background: rgba(10, 14, 27, 0.9);
        color: var(--ink);
        border-color: rgba(138, 150, 255, 0.18);
      }
      .pill,
      .button-link.secondary,
      button.secondary,
      .subtle-button {
        background: rgba(18, 22, 38, 0.84);
        color: var(--ink);
        border-color: rgba(138, 150, 255, 0.16);
      }
      .site-badge,
      .stack-pills span {
        background: rgba(124, 143, 255, 0.12);
        color: #cbd4ff;
      }
      .marketing-lead {
        color: #c3cbe7;
      }
      th,
      td {
        border-top-color: rgba(138, 150, 255, 0.1);
      }
    }
    @media (max-width: 900px) {
      .hero-grid,
      .marketing-features {
        grid-template-columns: 1fr;
      }
      .hero-board {
        min-height: 380px;
      }
      .hero-chart {
        min-height: 200px;
      }
      .hero-chart svg {
        height: 200px;
      }
      .hero-metrics {
        grid-template-columns: 1fr;
      }
      .marketing-hero {
        min-height: auto;
        padding-top: 1.2rem;
      }
      .item-toolbar {
        grid-template-columns: 1fr;
      }
      .metric-grid {
        grid-template-columns: 1fr;
      }
      .sparkline-meta,
      .item-group summary {
        flex-direction: column;
        align-items: flex-start;
      }
    }
  </style>
</head>
<body class="${escapeHtml(input.bodyClass ?? "")}">
  <main class="${(input.bodyClass ?? "").includes("marketing-shell") ? "marketing-main" : (input.bodyClass ?? "").includes("app-shell") ? "app-main" : ""}">
    ${input.nav ?? ""}
    ${input.heading ? `<section class="${(input.bodyClass ?? "").includes("app-shell") ? "app-hero" : "hero"}"><h1>${escapeHtml(input.heading)}</h1>${input.subheading ? `<p>${escapeHtml(input.subheading)}</p>` : ""}</section>` : ""}
    ${input.content}
  </main>
  <script>
    (() => {
      const setValue = (selector, value) => {
        if (!value) return;
        document.querySelectorAll(selector).forEach((input) => {
          if (input instanceof HTMLInputElement) {
            input.value = value;
          }
        });
      };

      const languages = Array.isArray(navigator.languages) && navigator.languages.length > 0
        ? navigator.languages
        : [navigator.language].filter(Boolean);
      setValue('[data-browser-context="accept-language"]', languages.join(','));
      setValue('[data-browser-context="browser-locale"]', navigator.language || '');

      try {
        setValue('[data-browser-context="browser-timezone"]', Intl.DateTimeFormat().resolvedOptions().timeZone || '');
      } catch {
        // Ignore timezone detection failures in older browsers.
      }
    })();
  </script>
</body>
</html>`;
}

function renderTrackedItemCard(item: TrackedItemWithHistory): string {
  const latest = item.latestCheck;
  const latestPrice = latest?.price ?? "";
  const lowestPrice = item.lowestPrice ?? "";
  const latestCheckedAt = latest?.checkedAt ?? "";
  const statusGroup = latest?.status === "error" ? "Errors" : "Tracked";
  const currencyGroup = item.currency || "No currency";
  const siteGroup = siteLabel(item.url);
  const rows = item.history.slice(0, 6).map((entry) => `
    <tr>
      <td>${escapeHtml(formatTimestamp(entry.checkedAt))}</td>
      <td>${entry.status === "ok" ? escapeHtml(formatPrice(entry.price, entry.currency)) : "Error"}</td>
      <td>${escapeHtml(entry.errorMessage ?? entry.rawText ?? "")}</td>
    </tr>
  `).join("");

  return `
    <article
      class="card tracked-item-card"
      data-name="${escapeAttribute(item.name.toLowerCase())}"
      data-latest-price="${escapeAttribute(latestPrice)}"
      data-lowest-price="${escapeAttribute(lowestPrice)}"
      data-latest-checked-at="${escapeAttribute(latestCheckedAt)}"
      data-status-group="${escapeAttribute(statusGroup)}"
      data-currency-group="${escapeAttribute(currencyGroup)}"
      data-site-group="${escapeAttribute(siteGroup)}"
    >
      <a class="site-badge" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(siteGroup)}</a>
      <h2>${escapeHtml(item.name)}</h2>
      <p class="muted tracked-item-subtitle">${escapeHtml(item.pageTitle ?? item.detectionSource ?? "Tracked item")}</p>
      <p class="url tracked-item-url"><a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.url)}</a></p>
      <dl class="metric-grid">
        <div>
          <dt>Latest</dt>
          <dd>${escapeHtml(formatPrice(latest?.price ?? null, latest?.currency ?? item.currency))}</dd>
        </div>
        <div>
          <dt>Lowest</dt>
          <dd>${escapeHtml(formatPrice(item.lowestPrice, item.currency))}</dd>
        </div>
        <div>
          <dt>Checked</dt>
          <dd>${escapeHtml(formatTimestamp(latest?.checkedAt ?? null))}</dd>
        </div>
      </dl>
      ${renderSparkline(item)}
      <details>
        <summary>Recent checks</summary>
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Result</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="3">No checks yet.</td></tr>'}
          </tbody>
        </table>
      </details>
      <div class="card-actions">
        <span class="muted">${item.enabled ? "Active" : "Paused"}</span>
        <form method="post" action="/app/items/${item.id}/delete" style="display:inline-grid;">
          <button class="secondary subtle-button" type="submit">Archive tracked item</button>
        </form>
      </div>
    </article>
  `;
}

function renderItemExplorer(sectionId: string, itemsHtml: string, emptyHtml: string): string {
  return `
    <section id="${escapeAttribute(sectionId)}" class="app-section">
      <div class="item-toolbar">
        <div class="field">
          <label for="${escapeAttribute(sectionId)}-sort">Sort by</label>
          <select id="${escapeAttribute(sectionId)}-sort" data-role="sort">
            <option value="checked">Last checked</option>
            <option value="name">Name</option>
            <option value="latest">Latest price</option>
            <option value="lowest">Lowest price</option>
          </select>
        </div>
        <div class="field">
          <label for="${escapeAttribute(sectionId)}-group">Group by</label>
          <select id="${escapeAttribute(sectionId)}-group" data-role="group">
            <option value="none">No grouping</option>
            <option value="status">Status</option>
            <option value="currency">Currency</option>
            <option value="site">Site</option>
          </select>
        </div>
      </div>
      <div class="hidden-source" data-role="source">
        ${itemsHtml}
      </div>
      <div class="item-groups" data-role="groups"></div>
      <template data-role="empty">${emptyHtml}</template>
    </section>
    <script>
      (() => {
        const section = document.getElementById(${JSON.stringify(sectionId)});
        if (!section) return;
        const source = section.querySelector('[data-role="source"]');
        const groupsHost = section.querySelector('[data-role="groups"]');
        const sortSelect = section.querySelector('[data-role="sort"]');
        const groupSelect = section.querySelector('[data-role="group"]');
        const emptyTemplate = section.querySelector('[data-role="empty"]');
        const cards = Array.from(source.children);
        const openState = new Map();

        const sorters = {
          name: (a, b) => a.dataset.name.localeCompare(b.dataset.name),
          latest: (a, b) => (Number.parseFloat(b.dataset.latestPrice || '-1') || -1) - (Number.parseFloat(a.dataset.latestPrice || '-1') || -1),
          lowest: (a, b) => (Number.parseFloat(b.dataset.lowestPrice || '-1') || -1) - (Number.parseFloat(a.dataset.lowestPrice || '-1') || -1),
          checked: (a, b) => (b.dataset.latestCheckedAt || '').localeCompare(a.dataset.latestCheckedAt || '')
        };

        const readGroup = (card, mode) => {
          if (mode === 'status') return card.dataset.statusGroup || 'Other';
          if (mode === 'currency') return card.dataset.currencyGroup || 'Other';
          if (mode === 'site') return card.dataset.siteGroup || 'Other';
          return 'All items';
        };

        const render = () => {
          const sortMode = sortSelect.value;
          const groupMode = groupSelect.value;
          groupsHost.innerHTML = '';

          if (!cards.length) {
            groupsHost.innerHTML = emptyTemplate.innerHTML;
            return;
          }

          const sorted = [...cards].sort(sorters[sortMode] || sorters.checked);
          const grouped = new Map();
          for (const card of sorted) {
            const key = groupMode === 'none' ? 'All items' : readGroup(card, groupMode);
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key).push(card.cloneNode(true));
          }

          for (const [key, groupCards] of grouped.entries()) {
            const details = document.createElement('details');
            details.className = 'item-group';
            details.open = openState.has(key) ? openState.get(key) : groupMode === 'none';
            details.innerHTML = '<summary><span class="item-group-title"></span><span class="item-group-count"></span></summary><div class="item-group-grid"></div>';
            details.querySelector('.item-group-title').textContent = key;
            details.querySelector('.item-group-count').textContent = groupCards.length + ' items';
            const grid = details.querySelector('.item-group-grid');
            groupCards.forEach((card) => grid.appendChild(card));
            details.addEventListener('toggle', () => openState.set(key, details.open));
            groupsHost.appendChild(details);
          }
        };

        sortSelect.addEventListener('change', render);
        groupSelect.addEventListener('change', render);
        render();
      })();
    </script>
  `;
}

function renderAppNav(user: UserRecord): string {
  return `
    <div class="topbar app-nav">
      <nav>
        <a class="pill" href="/app">Dashboard</a>
        <a class="pill" href="/app/settings">Settings</a>
        ${user.role === "admin" ? '<a class="pill" href="/admin">Platform Admin</a>' : ""}
      </nav>
      <div class="actions">
        <span class="muted">${escapeHtml(userDisplayName(user))}</span>
        <form method="post" action="/logout" style="display:inline-grid;">
          <button class="secondary" type="submit">Log out</button>
        </form>
      </div>
    </div>
  `;
}

export function renderLandingPage(): string {
  return renderShell({
    title: "PriceBuzz",
    bodyClass: "marketing-shell",
    nav: `
      <div class="topbar marketing-nav">
        <nav>
          <span class="brand">PriceBuzz</span>
        </nav>
        <div class="actions">
          <a class="button-link secondary" href="/login">Log in</a>
          <a class="button-link primary" href="/signup">Sign up</a>
        </div>
      </div>
    `,
    content: `
      <section class="marketing-hero">
        <div>
          <span class="eyebrow">Price tracking, refined</span>
          <h1>Know the moment a price moves.</h1>
          <p class="marketing-lead">Track the products that matter, follow price movement over time, and get notified quickly when a drop happens.</p>
          <div class="marketing-actions">
            <a class="button-link primary" href="/signup">Start tracking</a>
            <a class="button-link secondary" href="/login">Log in</a>
          </div>
          <div class="marketing-stage">
            <div class="hero-grid">
              <div class="hero-copy">
                <h2>Track prices with less friction and better signals.</h2>
                <p>Add products, follow movement over time, and send notifications when a drop matters.</p>
                <div class="hero-points">
                  <div class="hero-point">A simple flow for adding products and confirming what to track.</div>
                  <div class="hero-point">Clear history that makes trends and timing easy to read.</div>
                  <div class="hero-point">Notifications that can reach multiple recipients without extra work.</div>
                </div>
              </div>
              <div class="hero-board">
                <div class="hero-chart" aria-hidden="true">
                  <svg viewBox="0 0 420 220" role="presentation" preserveAspectRatio="none">
                    <polygon class="hero-chart-area" points="24,172 72,160 124,146 184,126 244,134 312,96 396,46 396,196 24,196"></polygon>
                    <polyline class="hero-chart-line" points="24,172 72,160 124,146 184,126 244,134 312,96 396,46"></polyline>
                    <circle class="hero-chart-point" cx="24" cy="172" r="7"></circle>
                    <circle class="hero-chart-point" cx="72" cy="160" r="7"></circle>
                    <circle class="hero-chart-point" cx="124" cy="146" r="7"></circle>
                    <circle class="hero-chart-point" cx="184" cy="126" r="7"></circle>
                    <circle class="hero-chart-point" cx="244" cy="134" r="7"></circle>
                    <circle class="hero-chart-point" cx="312" cy="96" r="7"></circle>
                    <circle class="hero-chart-point" cx="396" cy="46" r="7"></circle>
                  </svg>
                </div>
                <div class="hero-metrics">
                  <div class="hero-metric">
                    <small>Current price</small>
                    <strong>NZD 34.99</strong>
                  </div>
                  <div class="hero-metric">
                    <small>Lowest seen</small>
                    <strong>NZD 31.50</strong>
                  </div>
                </div>
                <div class="hero-caption">
                  <p>One focused view for price movement and recent history.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="marketing-section">
        <h2>Designed for clarity, not noise.</h2>
        <p>Everything about the product should make price tracking feel lighter: fewer steps, clearer signals, and a cleaner way to stay on top of the products you care about.</p>
        <div class="marketing-features">
          <article class="feature-panel">
            <div class="feature-art" aria-hidden="true">
              <svg viewBox="0 0 320 140" role="presentation">
                <rect x="30" y="28" width="160" height="84" rx="22" fill="rgba(255,255,255,0.88)" stroke="rgba(95,115,255,0.14)" />
                <rect x="48" y="46" width="124" height="14" rx="7" fill="rgba(95,115,255,0.14)" />
                <rect x="48" y="70" width="92" height="10" rx="5" fill="rgba(95,115,255,0.1)" />
                <rect x="48" y="88" width="68" height="10" rx="5" fill="rgba(95,115,255,0.1)" />
                <circle cx="238" cy="56" r="28" fill="rgba(95,115,255,0.1)" />
                <circle cx="260" cy="84" r="18" fill="rgba(118,196,255,0.18)" />
                <path d="M222 72 L238 88 L272 48" fill="none" stroke="rgba(95,115,255,0.72)" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </div>
            <small class="muted">Simple setup</small>
            <strong>Add new products in seconds.</strong>
            <p>Start tracking quickly with a guided flow that keeps the focus on the product, not the process.</p>
          </article>
          <article class="feature-panel">
            <div class="feature-art" aria-hidden="true">
              <svg viewBox="0 0 320 140" role="presentation">
                <rect x="28" y="24" width="264" height="92" rx="24" fill="rgba(255,255,255,0.88)" stroke="rgba(95,115,255,0.14)" />
                <path d="M52 98 C82 92, 100 82, 122 72 C146 62, 164 74, 188 60 C212 46, 236 44, 268 28" fill="none" stroke="rgba(95,115,255,0.7)" stroke-width="8" stroke-linecap="round" />
                <path d="M52 108 C84 102, 102 92, 124 82 C148 72, 166 82, 190 72 C214 62, 236 60, 268 44" fill="none" stroke="rgba(118,196,255,0.22)" stroke-width="18" stroke-linecap="round" />
                <circle cx="52" cy="98" r="6" fill="rgba(95,115,255,0.82)" />
                <circle cx="122" cy="72" r="6" fill="rgba(95,115,255,0.82)" />
                <circle cx="188" cy="60" r="6" fill="rgba(95,115,255,0.82)" />
                <circle cx="268" cy="28" r="6" fill="rgba(95,115,255,0.82)" />
              </svg>
            </div>
            <small class="muted">Clear history</small>
            <strong>See movement over time at a glance.</strong>
            <p>Every tracked item keeps a visual record so trends, drops, and timing are easy to understand.</p>
          </article>
          <article class="feature-panel">
            <div class="feature-art" aria-hidden="true">
              <svg viewBox="0 0 320 140" role="presentation">
                <rect x="42" y="38" width="86" height="64" rx="22" fill="rgba(255,255,255,0.88)" stroke="rgba(95,115,255,0.14)" />
                <rect x="194" y="30" width="88" height="80" rx="22" fill="rgba(255,255,255,0.88)" stroke="rgba(95,115,255,0.14)" />
                <path d="M130 70 H178" stroke="rgba(95,115,255,0.22)" stroke-width="6" stroke-linecap="round" />
                <path d="M158 58 L178 70 L158 82" fill="none" stroke="rgba(95,115,255,0.72)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" />
                <circle cx="85" cy="70" r="17" fill="rgba(118,196,255,0.18)" />
                <path d="M76 70 H94" stroke="rgba(95,115,255,0.72)" stroke-width="5" stroke-linecap="round" />
                <path d="M85 61 V79" stroke="rgba(95,115,255,0.72)" stroke-width="5" stroke-linecap="round" />
                <path d="M218 52 H258" stroke="rgba(95,115,255,0.72)" stroke-width="5" stroke-linecap="round" />
                <path d="M218 70 H258" stroke="rgba(95,115,255,0.72)" stroke-width="5" stroke-linecap="round" />
                <path d="M218 88 H246" stroke="rgba(95,115,255,0.72)" stroke-width="5" stroke-linecap="round" />
              </svg>
            </div>
            <small class="muted">Notifications</small>
            <strong>Send notifications when a drop matters.</strong>
            <p>Send timely price-drop notifications across email and Telegram, with support for multiple recipients.</p>
          </article>
        </div>
      </section>

      <section class="marketing-cta">
        <span class="eyebrow">Ready to start</span>
        <h2>Bring price tracking into a cleaner daily workflow.</h2>
        <p class="marketing-lead">Create an account, track the products that matter, and get notified without turning every price change into manual follow-up.</p>
        <div class="marketing-actions">
          <a class="button-link primary" href="/signup">Create an account</a>
          <a class="button-link secondary" href="/login">Access the app</a>
        </div>
      </section>
    `
  });
}

export function renderAuthPage(input: {
  mode: "login" | "signup";
  error?: string | null;
  notice?: string | null;
  values?: {
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
  };
}): string {
  const title = input.mode === "login" ? "Log In" : "Sign Up";
  const values = input.values ?? {};
  return renderShell({
    title,
    bodyClass: "app-shell",
    content: `
      <section class="auth-wrap">
        <div class="auth-box app-auth-box">
          <h2>${escapeHtml(title)}</h2>
          <p class="muted">${input.mode === "login" ? "Access your tracked items and notifications." : "Create your account to start tracking prices."}</p>
          ${input.notice ? `<p class="notice good">${escapeHtml(input.notice)}</p>` : ""}
          ${input.error ? `<p class="error">${escapeHtml(input.error)}</p>` : ""}
          <form method="post" action="/${input.mode}">
            ${input.mode === "signup" ? `
              <div class="forms" style="grid-template-columns: repeat(2, minmax(0, 1fr));">
                <label>First name <input name="firstName" required value="${escapeAttribute(values.firstName ?? "")}"></label>
                <label>Last name <input name="lastName" required value="${escapeAttribute(values.lastName ?? "")}"></label>
              </div>
            ` : ""}
            ${renderBrowserContextFields()}
            <label>Email <input name="email" type="email" required value="${escapeAttribute(values.email ?? "")}"></label>
            <label>Password <input name="password" type="password" required></label>
            <button type="submit">${escapeHtml(title)}</button>
          </form>
          <p class="muted">${input.mode === "login" ? 'Need an account? <a href="/signup">Sign up</a>.' : 'Already registered? <a href="/login">Log in</a>.'}</p>
        </div>
      </section>
    `
  });
}

export function renderUserDashboard(input: {
  user: UserRecord;
  items: TrackedItemWithHistory[];
  running: boolean;
  lastRunAt: string | null;
  notice?: string | null;
  error?: string | null;
  detectionPreview?: DetectionResult | null;
  overrideName?: string | null;
}): string {
  const preview = input.detectionPreview;
  const previewName = input.overrideName?.trim() || preview?.name || "";
  return renderShell({
    title: "Dashboard",
    bodyClass: "app-shell",
    nav: renderAppNav(input.user),
    heading: "Your tracked items",
    subheading: "See current prices, recent check history, and the lowest observed price for each item.",
    content: `
      ${input.notice ? `<p class="notice good">${escapeHtml(input.notice)}</p>` : ""}
      ${input.error ? `<p class="notice error">${escapeHtml(input.error)}</p>` : ""}
      ${!input.user.emailVerifiedAt ? `
        <section class="panel app-panel app-section">
          <h2>Verify your email</h2>
          <p class="muted">Your alerts default to ${escapeHtml(input.user.email)}. Verify it once and that same address can receive price alerts without the separate recipient confirmation flow.</p>
          <form method="post" action="/app/settings/email-verification/resend">
            <button type="submit">Resend verification email</button>
          </form>
        </section>
      ` : ""}
      ${preview ? `
        <section class="panel app-panel app-section">
          <h2>Detection preview</h2>
          <p class="muted">Review the detected price before saving this tracked item.</p>
          <dl class="metric-grid">
            <div>
              <dt>Name</dt>
              <dd>${escapeHtml(previewName)}</dd>
            </div>
            <div>
              <dt>Detected price</dt>
              <dd>${escapeHtml(formatPrice(preview.previewPrice, preview.currency))}</dd>
            </div>
            <div>
              <dt>Site</dt>
              <dd>${escapeHtml(siteLabel(preview.url))}</dd>
            </div>
          </dl>
          <p class="muted">We found a price on the page and will use it for future checks.</p>
          <form method="post" action="/app/items/confirm">
            <input type="hidden" name="name" value="${escapeHtml(previewName)}">
            <input type="hidden" name="pageTitle" value="${escapeHtml(preview.pageTitle ?? "")}">
            <input type="hidden" name="url" value="${escapeHtml(preview.url)}">
            <input type="hidden" name="selector" value="${escapeHtml(preview.selector ?? "")}">
            <input type="hidden" name="currency" value="${escapeHtml(preview.currency)}">
            <input type="hidden" name="initialDetectedPrice" value="${escapeHtml(preview.previewPrice)}">
            <input type="hidden" name="initialDetectedCurrency" value="${escapeHtml(preview.currency)}">
            <input type="hidden" name="initialDetectedRawText" value="${escapeHtml(preview.previewRawText)}">
            <input type="hidden" name="attribute" value="${escapeHtml(preview.attribute ?? "")}">
            <input type="hidden" name="regex" value="${escapeHtml(preview.regex ?? "")}">
            <input type="hidden" name="htmlRegex" value="${escapeHtml(preview.htmlRegex ?? "")}">
            <input type="hidden" name="detectionSource" value="${escapeHtml(preview.detectionSource)}">
            <div class="actions">
              <button type="submit">Save tracked item</button>
              <a class="button-link secondary" href="/app">Cancel</a>
            </div>
          </form>
        </section>
      ` : ""}
      <section class="panel app-panel app-section">
        <p class="muted">Paste a product URL. The app will fetch the page and try to detect the price automatically.</p>
        <form method="post" action="/app/items">
          ${renderBrowserContextFields()}
          <input name="url" type="url" required placeholder="Paste a product URL">
          <button type="submit">Track item</button>
        </form>
      </section>
      ${renderItemExplorer(
        "dashboard-items",
        input.items.map(renderTrackedItemCard).join(""),
        '<div class="panel app-panel"><h2>No tracked items yet</h2></div>'
      )}
    `
  });
}

export function renderOnboardingPage(input: {
  user: UserRecord;
  notice?: string | null;
  error?: string | null;
  detectionPreview?: DetectionResult | null;
  overrideName?: string | null;
}): string {
  const preview = input.detectionPreview;
  const previewName = input.overrideName?.trim() || preview?.name || "";
  return renderShell({
    title: "Get Started",
    bodyClass: "app-shell",
    nav: renderAppNav(input.user),
    heading: "Add your first tracked item",
    subheading: "Paste a product URL to try price detection now, or skip and do it later from the dashboard.",
    content: `
      ${input.notice ? `<p class="notice good">${escapeHtml(input.notice)}</p>` : ""}
      ${input.error ? `<p class="notice error">${escapeHtml(input.error)}</p>` : ""}
      ${preview ? `
        <section class="panel app-panel app-section">
          <h2>Detection preview</h2>
          <p class="muted">Review the detected price before saving your first tracked item.</p>
          <dl class="metric-grid">
            <div>
              <dt>Name</dt>
              <dd>${escapeHtml(previewName)}</dd>
            </div>
            <div>
              <dt>Detected price</dt>
              <dd>${escapeHtml(formatPrice(preview.previewPrice, preview.currency))}</dd>
            </div>
            <div>
              <dt>Site</dt>
              <dd>${escapeHtml(siteLabel(preview.url))}</dd>
            </div>
          </dl>
          <form method="post" action="/app/items/confirm">
            <input type="hidden" name="name" value="${escapeHtml(previewName)}">
            <input type="hidden" name="pageTitle" value="${escapeHtml(preview.pageTitle ?? "")}">
            <input type="hidden" name="url" value="${escapeHtml(preview.url)}">
            <input type="hidden" name="selector" value="${escapeHtml(preview.selector ?? "")}">
            <input type="hidden" name="currency" value="${escapeHtml(preview.currency)}">
            <input type="hidden" name="initialDetectedPrice" value="${escapeHtml(preview.previewPrice)}">
            <input type="hidden" name="initialDetectedCurrency" value="${escapeHtml(preview.currency)}">
            <input type="hidden" name="initialDetectedRawText" value="${escapeHtml(preview.previewRawText)}">
            <input type="hidden" name="attribute" value="${escapeHtml(preview.attribute ?? "")}">
            <input type="hidden" name="regex" value="${escapeHtml(preview.regex ?? "")}">
            <input type="hidden" name="htmlRegex" value="${escapeHtml(preview.htmlRegex ?? "")}">
            <input type="hidden" name="detectionSource" value="${escapeHtml(preview.detectionSource)}">
            <div class="actions">
              <button type="submit">Save tracked item</button>
              <a class="button-link secondary" href="/app/onboarding">Try another URL</a>
            </div>
          </form>
        </section>
      ` : ""}
      <section class="panel app-panel app-section">
        <p class="muted">Paste a product URL. The app will fetch the page and try to detect the price automatically.</p>
        <form method="post" action="/app/onboarding/item">
          ${renderBrowserContextFields()}
          <input name="url" type="url" required placeholder="Paste a product URL">
          <div class="actions">
            <button type="submit">Preview item</button>
            <a class="button-link secondary" href="/app">Skip for now</a>
          </div>
        </form>
      </section>
    `
  });
}

export function renderUserAdminPage(input: {
  user: UserRecord;
  channels: NotificationChannelRecord[];
  telegramLinks: TelegramLinkTokenRecord[];
  telegramBotUsername: string | null;
  notice?: string | null;
  error?: string | null;
  detectionPreview?: DetectionResult | null;
  overrideName?: string | null;
}): string {
  const channelRows = input.channels.map((channel) => `
    <tr>
      <td>${escapeHtml(channel.type)}</td>
      <td>
        ${channel.displayName ? `<strong>${escapeHtml(channel.displayName)}</strong><br>` : ""}
        <span class="muted">${escapeHtml(channel.target)}</span>
      </td>
      <td>${channel.type === "email" && !channel.verifiedAt ? "Pending verification" : channel.enabled ? "Enabled" : "Disabled"}</td>
      <td>${escapeHtml(formatTimestamp(channel.createdAt))}</td>
    </tr>
  `).join("");
  const telegramLinkRows = input.telegramLinks.map((link) => {
    const href = input.telegramBotUsername ? `https://t.me/${encodeURIComponent(input.telegramBotUsername)}?start=${encodeURIComponent(link.token)}` : "";
    return `
      <tr>
        <td>${href ? `<a href="${href}" target="_blank" rel="noreferrer">${escapeHtml(href)}</a>` : `<span class="muted">Set TELEGRAM_BOT_USERNAME to generate a direct link.</span>`}</td>
        <td>${escapeHtml(formatTimestamp(link.expiresAt))}</td>
      </tr>
    `;
  }).join("");

  return renderShell({
    title: "Settings",
    bodyClass: "app-shell",
    nav: renderAppNav(input.user),
    heading: "Settings",
    subheading: "Configure where price-drop alerts should go.",
    content: `
      ${input.notice ? `<p class="notice good">${escapeHtml(input.notice)}</p>` : ""}
      ${input.error ? `<p class="notice error">${escapeHtml(input.error)}</p>` : ""}
      <section class="panel app-panel app-section">
        <h2>Account email</h2>
        <p class="muted">${userFullName(input.user) ? `${escapeHtml(userFullName(input.user) ?? "")}<br>` : ""}${escapeHtml(input.user.email)}</p>
        <p class="muted">${input.user.emailVerifiedAt
          ? `Verified on ${escapeHtml(formatTimestamp(input.user.emailVerifiedAt))}. This address is the default recipient for price alerts.`
          : "Not verified yet. This address is reserved as your default recipient, but alerts stay blocked until you verify it."}</p>
        ${!input.user.emailVerifiedAt ? `
          <form method="post" action="/app/settings/email-verification/resend">
            <button type="submit">Resend verification email</button>
          </form>
        ` : ""}
      </section>
      <section class="forms app-section" style="grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));">
        <div class="panel app-panel">
          <h2>Connect Telegram recipients</h2>
          <p class="muted">Generate a Telegram link, send it to a recipient, and ask them to press Start in your bot. They never need to find a chat ID.</p>
          <form method="post" action="/app/settings/notifications/telegram-links">
            <button type="submit">Generate Telegram connect link</button>
          </form>
          ${input.telegramLinks.length > 0 ? `
            <table class="compact-table" style="margin-top: 1rem;">
              <thead>
                <tr>
                  <th>Pending link</th>
                  <th>Expires</th>
                </tr>
              </thead>
              <tbody>
                ${telegramLinkRows}
              </tbody>
            </table>
          ` : '<p class="muted">No pending Telegram links.</p>'}
        </div>
      </section>
      <section class="panel app-panel app-section">
        <h2>Notification channels</h2>
        <table class="compact-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Target</th>
              <th>Status</th>
              <th>Added</th>
            </tr>
          </thead>
          <tbody>
            ${channelRows || '<tr><td colspan="4">No channels configured.</td></tr>'}
          </tbody>
        </table>
      </section>
    `
  });
}

export function renderPlatformAdminPage(input: {
  user: UserRecord;
  users: UserWithCounts[];
  items: PlatformTrackedItem[];
  notice?: string | null;
  error?: string | null;
}): string {
  const userRows = input.users.map((user) => `
    <tr>
      <td>${escapeHtml(user.email)}</td>
      <td>${escapeHtml(user.role)}</td>
      <td>${user.isActive ? "Active" : "Inactive"}</td>
      <td>${user.trackedItemCount}</td>
      <td>${user.channelCount}</td>
      <td>${escapeHtml(formatTimestamp(user.createdAt))}</td>
    </tr>
  `).join("");

  const itemRows = input.items.map((item) => `
    <tr>
      <td>${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.ownerEmail)}</td>
      <td class="url">${escapeHtml(item.url)}</td>
      <td>${item.enabled ? "Enabled" : "Disabled"}</td>
      <td>${escapeHtml(formatPrice(item.latestPrice, ""))}</td>
      <td>${escapeHtml(item.latestStatus ?? "Never checked")}</td>
      <td>${escapeHtml(formatTimestamp(item.latestCheckedAt))}</td>
    </tr>
  `).join("");

  return renderShell({
    title: "Platform Admin",
    bodyClass: "app-shell",
    nav: renderAppNav(input.user),
    heading: "Platform Admin",
    subheading: "View registered users, tracked items, and recent platform-wide activity.",
    content: `
      ${input.notice ? `<p class="notice good">${escapeHtml(input.notice)}</p>` : ""}
      ${input.error ? `<p class="notice error">${escapeHtml(input.error)}</p>` : ""}
      <section class="stats app-stats app-section">
        <div class="stat app-stat"><small>Users</small><strong>${input.users.length}</strong></div>
        <div class="stat app-stat"><small>Admin users</small><strong>${input.users.filter((user) => user.role === "admin").length}</strong></div>
      </section>
      <section class="forms app-section" style="grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));">
        <div class="panel app-panel">
          <h2>Test email notifications</h2>
          <p class="muted">Send a direct test email through the configured Resend account. You can send to one or many recipients.</p>
          <form method="post" action="/admin/test/email">
            <label>Recipients
              <textarea name="targets" rows="4" required placeholder="One per line, or comma separated"></textarea>
            </label>
            <button type="submit">Send test email</button>
          </form>
        </div>
        <div class="panel app-panel">
          <h2>Test Telegram notifications</h2>
          <p class="muted">Send a direct Telegram test message to one or many connected chat IDs.</p>
          <form method="post" action="/admin/test/telegram">
            <label>Chat IDs
              <textarea name="targets" rows="4" required placeholder="One per line, or comma separated"></textarea>
            </label>
            <button type="submit">Send test Telegram</button>
          </form>
        </div>
      </section>
      <section class="panel app-panel app-section">
        <h2>Registered users</h2>
        <table class="compact-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Items</th>
              <th>Channels</th>
              <th>Joined</th>
            </tr>
          </thead>
          <tbody>
            ${userRows || '<tr><td colspan="6">No users yet.</td></tr>'}
          </tbody>
        </table>
      </section>
      <section class="panel app-panel app-section">
        <h2>Tracked items</h2>
        <table class="compact-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Owner</th>
              <th>URL</th>
              <th>Status</th>
              <th>Latest price</th>
              <th>Latest check</th>
              <th>Checked at</th>
            </tr>
          </thead>
          <tbody>
            ${itemRows || '<tr><td colspan="7">No tracked items yet.</td></tr>'}
          </tbody>
        </table>
      </section>
    `
  });
}
