import type { FormEvent, ReactElement } from "react";
import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  createItem,
  createTelegramLink,
  deleteAdminItem,
  deleteAdminUser,
  deleteItem,
  detectItem,
  getAdmin,
  getDashboard,
  getSession,
  getSettings,
  login,
  logout,
  resendVerification,
  runChecks,
  scrapeDebug,
  sendAdminTestEmail,
  sendAdminTestTelegram,
  signup,
  updateAdminItem,
  updateAdminUser
} from "./lib/api";
import type {
  DetectionResult,
  PlatformTrackedItem,
  ScrapeDebugResult,
  TrackedItemWithHistory,
  User,
  UserWithCounts
} from "./lib/types";

type SessionState = {
  status: "loading" | "ready";
  user: User | null;
};

type Banner = {
  notice: string | null;
  error: string | null;
};

type ItemSortMode = "checked" | "name" | "latest" | "lowest";
type ItemGroupMode = "none" | "status" | "currency" | "site";
type AdminRunSummary = {
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

function App() {
  const [session, setSession] = useState<SessionState>({ status: "loading", user: null });

  useEffect(() => {
    void getSession()
      .then((payload) => {
        setSession({ status: "ready", user: payload.user });
      })
      .catch(() => {
        setSession({ status: "ready", user: null });
      });
  }, []);

  if (session.status === "loading") {
    return <div className="screen-center">Loading…</div>;
  }

  return (
    <Routes>
      <Route path="/" element={<LandingPage user={session.user} />} />
      <Route path="/login" element={<LoginPage onAuthenticated={(user) => setSession({ status: "ready", user })} />} />
      <Route path="/signup" element={<SignupPage onAuthenticated={(user) => setSession({ status: "ready", user })} />} />
      <Route
        path="/app"
        element={
          <RequireUser user={session.user}>
            <DashboardPage user={session.user!} />
          </RequireUser>
        }
      />
      <Route
        path="/app/settings"
        element={
          <RequireUser user={session.user}>
            <SettingsPage user={session.user!} onUserChanged={(user) => setSession({ status: "ready", user })} />
          </RequireUser>
        }
      />
      <Route
        path="/admin"
        element={
          <RequireAdmin user={session.user}>
            <AdminPage user={session.user!} />
          </RequireAdmin>
        }
      />
      <Route path="*" element={<Navigate to={session.user ? "/app" : "/"} replace />} />
    </Routes>
  );
}

function RequireUser({ user, children }: { user: User | null; children: ReactElement }) {
  const location = useLocation();
  if (!user) {
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  }
  return children;
}

function RequireAdmin({ user, children }: { user: User | null; children: ReactElement }) {
  if (!user) {
    return <Navigate to="/login?next=%2Fadmin" replace />;
  }
  if (user.role !== "admin") {
    return <Navigate to="/app" replace />;
  }
  return children;
}

function LandingPage({ user }: { user: User | null }) {
  return (
    <div className="shell marketing-shell">
      <header className="topbar">
        <div className="brand">PriceBuzz</div>
        <nav className="nav">
          {user ? <Link to="/app">Open app</Link> : <><Link to="/login">Log in</Link><Link className="button-link" to="/signup">Sign up</Link></>}
        </nav>
      </header>
      <main className="marketing-main">
        <section className="hero hero-grid">
          <div className="hero-copy">
            <p className="eyebrow">Stay on top of price drops.</p>
            <h1>Track the products you want and get a heads-up when the price drops.</h1>
            <div className="hero-actions">
              {user ? <Link className="button-link primary" to="/app">Start tracking</Link> : <>
                <Link className="button-link primary" to="/signup">Start tracking</Link>
                <Link className="button-link" to="/login">Log in</Link>
              </>}
            </div>
          </div>
          <div className="hero-preview">
            <div className="preview-card">
              <div className="preview-chart">
                <svg viewBox="0 0 320 160" preserveAspectRatio="none" aria-hidden="true">
                  <defs>
                    <linearGradient id="landing-preview-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="rgba(15, 123, 255, 0.36)" />
                      <stop offset="100%" stopColor="rgba(15, 123, 255, 0.04)" />
                    </linearGradient>
                  </defs>
                  <line x1="20" y1="132" x2="300" y2="132" className="sparkline-baseline" />
                  <polygon
                    fill="url(#landing-preview-fill)"
                    points="20,132 20,100 64,104 108,84 152,88 196,60 240,68 284,38 300,44 300,132"
                  />
                  <polyline
                    className="sparkline-line"
                    points="20,100 64,104 108,84 152,88 196,60 240,68 284,38 300,44"
                  />
                </svg>
              </div>
              <div className="preview-stats">
                <div>
                  <span>Current price</span>
                  <strong>NZD 34.99</strong>
                </div>
                <div>
                  <span>Lowest seen</span>
                  <strong>NZD 31.50</strong>
                </div>
              </div>
              <p className="preview-copy">See the latest price, the lowest price, and how it has changed over time in one place.</p>
            </div>
          </div>
        </section>

        <section className="marketing-section feature-intro">
          <div className="section-copy">
            <p className="eyebrow">Track prices without the hassle.</p>
            <h2>Add products in a few clicks, watch the price over time, and get a message when it drops.</h2>
          </div>
          <div className="marketing-grid three">
            <article className="marketing-card">
              <h3>Simple setup</h3>
              <p>Add a product and start tracking it without a bunch of extra steps.</p>
            </article>
            <article className="marketing-card">
              <h3>Clear history</h3>
              <p>See how the price has moved over time without digging through clutter.</p>
            </article>
            <article className="marketing-card">
              <h3>Notifications</h3>
              <p>Get price-drop alerts where you want them.</p>
            </article>
          </div>
        </section>

        <section className="marketing-section">
          <div className="section-copy narrow">
            <h2>PriceBuzz is made to feel simple: fewer steps, clearer updates, and an easier way to stay on top of the things you want to buy.</h2>
          </div>
        </section>

        <section className="marketing-section">
          <div className="marketing-grid three">
            <article className="marketing-card">
              <h3>Simple setup</h3>
              <p className="marketing-kicker">Add new products in seconds.</p>
              <p>Add the product, check that it looks right, and you are done.</p>
            </article>
            <article className="marketing-card">
              <h3>Clear history</h3>
              <p className="marketing-kicker">See movement over time at a glance.</p>
              <p>Each item keeps a simple price history so you can quickly see what is going on.</p>
            </article>
            <article className="marketing-card">
              <h3>Notifications</h3>
              <p className="marketing-kicker">Get notified when the price drops.</p>
              <p>Get notified by email or Telegram when the price drops.</p>
            </article>
          </div>
        </section>
      </main>
    </div>
  );
}

function LoginPage({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<Banner>({
    notice: searchParams.get("notice"),
    error: searchParams.get("error")
  });

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setBanner({ notice: null, error: null });
    try {
      const payload = await login({
        email,
        password,
        acceptLanguage: navigator.language,
        browserLocale: navigator.language,
        browserTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone
      });
      onAuthenticated(payload.user);
      navigate("/app");
    } catch (error) {
      setBanner({ notice: null, error: error instanceof Error ? error.message : "Login failed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Log in">
      <BannerBox banner={banner} />
      <form className="stack" onSubmit={handleSubmit}>
        <label className="field">
          <span>Email</span>
          <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" required />
        </label>
        <label className="field">
          <span>Password</span>
          <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" required />
        </label>
        <button className="button primary" disabled={busy}>{busy ? "Logging in…" : "Log in"}</button>
        <p className="small-copy">No account yet? <Link to="/signup">Create one</Link>.</p>
      </form>
    </AuthLayout>
  );
}

function SignupPage({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const navigate = useNavigate();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<Banner>({ notice: null, error: null });

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setBanner({ notice: null, error: null });
    try {
      const payload = await signup({
        firstName,
        lastName,
        email,
        password,
        acceptLanguage: navigator.language,
        browserLocale: navigator.language,
        browserTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone
      });
      onAuthenticated(payload.user);
      navigate("/app", { state: { notice: payload.notice } });
    } catch (error) {
      setBanner({ notice: null, error: error instanceof Error ? error.message : "Signup failed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Create account">
      <BannerBox banner={banner} />
      <form className="stack" onSubmit={handleSubmit}>
        <div className="grid two">
          <label className="field">
            <span>First name</span>
            <input value={firstName} onChange={(event) => setFirstName(event.target.value)} required />
          </label>
          <label className="field">
            <span>Last name</span>
            <input value={lastName} onChange={(event) => setLastName(event.target.value)} required />
          </label>
        </div>
        <label className="field">
          <span>Email</span>
          <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" required />
        </label>
        <label className="field">
          <span>Password</span>
          <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" minLength={8} required />
        </label>
        <button className="button primary" disabled={busy}>{busy ? "Creating account…" : "Create account"}</button>
        <p className="small-copy">Already registered? <Link to="/login">Log in</Link>.</p>
      </form>
    </AuthLayout>
  );
}

function DashboardPage({ user }: { user: User }) {
  const location = useLocation();
  const [busy, setBusy] = useState(true);
  const [banner, setBanner] = useState<Banner>({
    notice: (location.state as { notice?: string } | null)?.notice ?? null,
    error: null
  });
  const [items, setItems] = useState<TrackedItemWithHistory[]>([]);
  const [detectUrl, setDetectUrl] = useState("");
  const [detectBusy, setDetectBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [detection, setDetection] = useState<DetectionResult | null>(null);
  const [nameOverride, setNameOverride] = useState("");
  const [sortMode, setSortMode] = useState<ItemSortMode>("checked");
  const [groupMode, setGroupMode] = useState<ItemGroupMode>("none");
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void getDashboard()
      .then((payload) => {
        setItems(payload.items);
      })
      .catch((error) => {
        setBanner({ notice: null, error: error instanceof Error ? error.message : "Failed to load dashboard." });
      })
      .finally(() => setBusy(false));
  }, []);

  async function handleDetect(event: FormEvent) {
    event.preventDefault();
    setDetectBusy(true);
    setBanner({ notice: null, error: null });
    try {
      const payload = await detectItem({
        url: detectUrl,
        acceptLanguage: navigator.language,
        browserLocale: navigator.language,
        browserTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone
      });
      setDetection(payload.detection);
      setNameOverride(payload.detection.name);
    } catch (error) {
      setBanner({ notice: null, error: error instanceof Error ? error.message : "Failed to detect item." });
    } finally {
      setDetectBusy(false);
    }
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!detection) return;
    setSaveBusy(true);
    setBanner({ notice: null, error: null });
    try {
      const payload = await createItem({
        name: nameOverride || detection.name,
        pageTitle: detection.pageTitle,
        url: detection.url,
        currency: detection.currency,
        initialDetectedPrice: detection.previewPrice,
        initialDetectedCurrency: detection.currency,
        initialDetectedRawText: detection.previewRawText,
        detectionSource: detection.detectionSource
      });
      setItems(payload.dashboard.items);
      setBanner({ notice: payload.notice, error: null });
      setDetection(null);
      setNameOverride("");
      setDetectUrl("");
    } catch (error) {
      setBanner({ notice: null, error: error instanceof Error ? error.message : "Failed to save tracked item." });
    } finally {
      setSaveBusy(false);
    }
  }

  async function handleDelete(id: number) {
    try {
      const payload = await deleteItem(id);
      setItems(payload.dashboard.items);
      setBanner({ notice: payload.notice, error: null });
    } catch (error) {
      setBanner({ notice: null, error: error instanceof Error ? error.message : "Failed to delete item." });
    }
  }

  if (busy) {
    return <AppShell user={user}><div className="screen-center">Loading dashboard…</div></AppShell>;
  }

  const groupedItems = groupAndSortItems(items, sortMode, groupMode);

  return (
    <AppShell user={user}>
      <section className="page-header">
        <div>
          <p className="eyebrow">Dashboard</p>
          <h1>{items.length === 0 ? "Add your first item" : "Your tracked items"}</h1>
        </div>
      </section>

      <BannerBox banner={banner} />

      <section className="grid page-grid">
        <div className="panel panel-span-full">
          <h2>Add an item</h2>
          <form className="stack" onSubmit={handleDetect}>
            <label className="field">
              <input value={detectUrl} onChange={(event) => setDetectUrl(event.target.value)} placeholder="https://…" required />
            </label>
            <button className="button primary" disabled={detectBusy}>{detectBusy ? "Checking…" : "Check price"}</button>
          </form>
        </div>
      </section>

      {detection && (
        <section className="panel">
          <h2>Check the details</h2>
          <form className="stack" onSubmit={handleSave}>
            <div className="grid two review-grid">
              <div className="field">
                <span>Name</span>
                <div className="field-display">{nameOverride || detection.name}</div>
              </div>
              <div className="field">
                <span>Price found</span>
                <div className="field-display">{formatPrice(detection.previewPrice, detection.currency)}</div>
              </div>
            </div>
            <button className="button primary" disabled={saveBusy}>{saveBusy ? "Saving…" : "Start tracking"}</button>
          </form>
        </section>
      )}

      <section className="panel">
        <div className="section-header">
          <h2>Your items</h2>
          <span className="muted">{items.length === 0 ? "No items yet." : `${items.length} active`}</span>
        </div>
        {items.length === 0 ? (
          <div className="empty-state">
            <p>No items yet. Add a link above to start tracking your first one.</p>
          </div>
        ) : (
          <>
            <div className="item-toolbar">
              <label className="field">
                <span>Sort by</span>
                <select value={sortMode} onChange={(event) => setSortMode(event.target.value as ItemSortMode)}>
                  <option value="checked">Last checked</option>
                  <option value="name">Name</option>
                  <option value="latest">Latest price</option>
                  <option value="lowest">Lowest price</option>
                </select>
              </label>
              <label className="field">
                <span>Group by</span>
                <select value={groupMode} onChange={(event) => setGroupMode(event.target.value as ItemGroupMode)}>
                  <option value="none">No grouping</option>
                  <option value="status">Status</option>
                  <option value="currency">Currency</option>
                  <option value="site">Site</option>
                </select>
              </label>
            </div>
            <div className="item-groups">
              {groupedItems.map(([groupName, groupItems]) => (
                <details
                  key={groupName}
                  className="item-group"
                  open={groupMode === "none" ? true : Boolean(openGroups[groupName])}
                  onToggle={(event) => {
                    if (groupMode === "none") return;
                    const nextOpen = (event.currentTarget as HTMLDetailsElement).open;
                    setOpenGroups((current) => ({ ...current, [groupName]: nextOpen }));
                  }}
                >
                  <summary className="item-group-header">
                    <h3>{groupName}</h3>
                    <span className="muted">{groupItems.length} item{groupItems.length === 1 ? "" : "s"}</span>
                  </summary>
                  <div className="item-list">
                    {groupItems.map((item) => (
                      <article key={item.id} className="item-card">
                        <div className="item-card-header">
                          <div className="item-card-copy">
                            <div className="item-card-topline">
                              <a className="site-badge" href={siteHomeUrl(item.url)} target="_blank" rel="noreferrer">{siteLabel(item.url)}</a>
                            </div>
                            <h3>{item.name}</h3>
                            <a className="item-url" href={item.url} target="_blank" rel="noreferrer">{item.url}</a>
                          </div>
                          <button className="button danger" onClick={() => void handleDelete(item.id)}>Archive</button>
                        </div>
                        <dl className="stats-list compact">
                          <div><dt>Current</dt><dd>{formatPrice(item.latestCheck?.price ?? null, item.latestCheck?.currency ?? item.currency)}</dd></div>
                          <div><dt>Lowest</dt><dd>{formatPrice(item.lowestPrice, item.currency)}</dd></div>
                          <div><dt>Checked</dt><dd>{formatTimestamp(item.latestCheck?.checkedAt ?? null)}</dd></div>
                        </dl>
                        <Sparkline item={item} />
                        <div className="history-block">
                          <h4>Recent prices</h4>
                          <ul>
                            {item.history.length === 0 ? <li>No prices yet.</li> : item.history.map((entry) => (
                              <li key={entry.id}>
                                <span>{formatTimestamp(entry.checkedAt)}</span>
                                <span>{entry.status === "ok" ? formatPrice(entry.price, entry.currency) : "An error occurred"}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </article>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          </>
        )}
      </section>
    </AppShell>
  );
}

function Sparkline({ item }: { item: TrackedItemWithHistory }) {
  const points = item.history
    .filter((entry) => entry.status === "ok" && entry.price)
    .slice()
    .reverse()
    .map((entry) => Number.parseFloat(entry.price ?? ""))
    .filter((value) => Number.isFinite(value));

  if (points.length === 0) {
    return <div className="sparkline-empty">No price history yet.</div>;
  }

  const chartPoints = points.length === 1 ? [points[0], points[0]] : points;
  const width = 240;
  const height = 78;
  const padding = 10;
  const min = Math.min(...chartPoints);
  const max = Math.max(...chartPoints);
  const range = max - min || 1;

  const linePoints = chartPoints.map((value, index) => {
    const x = padding + (index * (width - padding * 2)) / (chartPoints.length - 1);
    const normalized = (value - min) / range;
    const y = height - padding - normalized * (height - padding * 2);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const areaPoints = [
    `${padding},${height - padding}`,
    ...linePoints,
    `${width - padding},${height - padding}`
  ].join(" ");

  return (
    <div className="sparkline">
      <div className="sparkline-meta">
        <span>Trend</span>
        <span>{formatPrice(min.toFixed(2), item.currency)} to {formatPrice(max.toFixed(2), item.currency)}</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} className="sparkline-baseline" />
        <defs>
          <linearGradient id={`sparkline-fill-${item.id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(15, 123, 255, 0.26)" />
            <stop offset="100%" stopColor="rgba(15, 123, 255, 0.04)" />
          </linearGradient>
        </defs>
        <polygon points={areaPoints} fill={`url(#sparkline-fill-${item.id})`} className="sparkline-fill" />
        <polyline points={linePoints.join(" ")} className="sparkline-line" />
      </svg>
    </div>
  );
}

function SettingsPage({
  user,
  onUserChanged
}: {
  user: User;
  onUserChanged: (user: User) => void;
}) {
  const [busy, setBusy] = useState(true);
  const [banner, setBanner] = useState<Banner>({ notice: null, error: null });
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof getSettings>> | null>(null);

  useEffect(() => {
    void getSettings()
      .then((payload) => {
        setSettings(payload);
        onUserChanged(payload.user);
      })
      .catch((error) => {
        setBanner({ notice: null, error: error instanceof Error ? error.message : "Failed to load settings." });
      })
      .finally(() => setBusy(false));
  }, [onUserChanged]);

  async function handleResend() {
    try {
      const payload = await resendVerification();
      setBanner({ notice: payload.notice, error: null });
    } catch (error) {
      setBanner({ notice: null, error: error instanceof Error ? error.message : "Failed to resend verification." });
    }
  }

  async function handleTelegramLink() {
    try {
      const payload = await createTelegramLink();
      setSettings(payload.settings);
      setBanner({ notice: payload.notice, error: null });
    } catch (error) {
      setBanner({ notice: null, error: error instanceof Error ? error.message : "Failed to create Telegram link." });
    }
  }

  if (busy) {
    return <AppShell user={user}><div className="screen-center">Loading settings…</div></AppShell>;
  }

  return (
    <AppShell user={user}>
      <section className="page-header">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Notification and account settings</h1>
        </div>
      </section>
      <BannerBox banner={banner} />
      <section className="grid page-grid">
        <div className="panel">
          <h2>Account</h2>
          <dl className="stats-list">
            <div><dt>Name</dt><dd>{user.firstName} {user.lastName}</dd></div>
            <div><dt>Email</dt><dd>{user.email}</dd></div>
            <div><dt>Email verified</dt><dd>{user.emailVerifiedAt ? "Yes" : "No"}</dd></div>
          </dl>
          {!user.emailVerifiedAt && (
            <button className="button primary" onClick={handleResend}>Resend verification email</button>
          )}
        </div>
        <div className="panel">
          <h2>Telegram</h2>
          {settings?.telegramBotUsername && (
            <p className="muted">Bot username: @{settings.telegramBotUsername}</p>
          )}
          <div className="action-row">
            <button className="button primary" onClick={handleTelegramLink}>Create Telegram connect link</button>
          </div>
          <ul className="token-list">
            {(settings?.telegramLinks ?? []).map((token) => (
              <li key={token.id}>
                <code>{token.token}</code>
                <span>expires {formatTimestamp(token.expiresAt)}</span>
              </li>
            ))}
            {(settings?.telegramLinks ?? []).length === 0 && <li>No active Telegram links.</li>}
          </ul>
        </div>
      </section>
      <section className="panel">
        <h2>Notification channels</h2>
        <table className="table">
          <thead><tr><th>Type</th><th>Target</th><th>Verified</th></tr></thead>
          <tbody>
            {(settings?.channels ?? []).map((channel) => (
              <tr key={channel.id}>
                <td>{channel.type}</td>
                <td>{channel.target}</td>
                <td>{channel.verifiedAt ? formatTimestamp(channel.verifiedAt) : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </AppShell>
  );
}

function AdminPage({ user }: { user: User }) {
  const [busy, setBusy] = useState(true);
  const [banner, setBanner] = useState<Banner>({ notice: null, error: null });
  const [users, setUsers] = useState<UserWithCounts[]>([]);
  const [items, setItems] = useState<PlatformTrackedItem[]>([]);
  const [trackerState, setTrackerState] = useState<{ running: boolean; lastRunAt: string | null }>({ running: false, lastRunAt: null });
  const [emailTargets, setEmailTargets] = useState("");
  const [telegramTargets, setTelegramTargets] = useState("");
  const [scrapeUrl, setScrapeUrl] = useState("");
  const [scrapeResult, setScrapeResult] = useState<ScrapeDebugResult | null>(null);
  const [runSummary, setRunSummary] = useState<AdminRunSummary | null>(null);

  useEffect(() => {
    void getAdmin()
      .then((payload) => {
        setUsers(payload.users);
        setItems(payload.items);
        setTrackerState(payload.tracker);
      })
      .catch((error) => {
        setBanner({ notice: null, error: error instanceof Error ? error.message : "Failed to load admin data." });
      })
      .finally(() => setBusy(false));
  }, []);

  function applyAdminPayload(payload: {
    users: UserWithCounts[];
    items: PlatformTrackedItem[];
    tracker: { running: boolean; lastRunAt: string | null };
  }) {
    setUsers(payload.users);
    setItems(payload.items);
    setTrackerState(payload.tracker);
  }

  async function refreshAdmin() {
    const payload = await getAdmin();
    applyAdminPayload(payload);
  }

  async function handleEmail(event: FormEvent) {
    event.preventDefault();
    try {
      const payload = await sendAdminTestEmail(emailTargets);
      setBanner({ notice: payload.notice, error: null });
    } catch (error) {
      setBanner({ notice: null, error: error instanceof Error ? error.message : "Failed to send test email." });
    }
  }

  async function handleTelegram(event: FormEvent) {
    event.preventDefault();
    try {
      const payload = await sendAdminTestTelegram(telegramTargets);
      setBanner({ notice: payload.notice, error: null });
    } catch (error) {
      setBanner({ notice: null, error: error instanceof Error ? error.message : "Failed to send Telegram test message." });
    }
  }

  async function handleScrapeDebug(event: FormEvent) {
    event.preventDefault();
    try {
      const payload = await scrapeDebug({
        url: scrapeUrl,
        acceptLanguage: navigator.language,
        browserLocale: navigator.language,
        browserTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone
      });
      setScrapeResult(payload.scrapeDebug);
      setBanner({ notice: payload.notice, error: payload.error });
      await refreshAdmin();
    } catch (error) {
      setBanner({ notice: null, error: error instanceof Error ? error.message : "Failed to fetch scrape debug." });
    }
  }

  async function handleRunChecks() {
    try {
      const payload = await runChecks();
      setBanner({ notice: payload.notice, error: null });
      setRunSummary(payload.runSummary);
      applyAdminPayload(payload.admin);
    } catch (error) {
      setBanner({ notice: null, error: error instanceof Error ? error.message : "Failed to run checks." });
    }
  }

  async function handleAdminUserSave(event: FormEvent<HTMLFormElement>, targetUserId: number) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    try {
      const payload = await updateAdminUser(targetUserId, {
        firstName: String(form.get("firstName") ?? ""),
        lastName: String(form.get("lastName") ?? ""),
        email: String(form.get("email") ?? ""),
        role: String(form.get("role")) === "admin" ? "admin" : "user",
        isActive: form.get("isActive") === "on"
      });
      setBanner({ notice: payload.notice, error: null });
      applyAdminPayload(payload.admin);
    } catch (error) {
      setBanner({ notice: null, error: error instanceof Error ? error.message : "Failed to update user." });
    }
  }

  async function handleAdminUserDelete(targetUserId: number, email: string) {
    if (!window.confirm(`Delete ${email} and all of their data?`)) {
      return;
    }

    try {
      const payload = await deleteAdminUser(targetUserId);
      setBanner({ notice: payload.notice, error: null });
      applyAdminPayload(payload.admin);
    } catch (error) {
      setBanner({ notice: null, error: error instanceof Error ? error.message : "Failed to delete user." });
    }
  }

  async function handleAdminItemSave(event: FormEvent<HTMLFormElement>, trackedItemId: number) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    try {
      const payload = await updateAdminItem(trackedItemId, {
        name: String(form.get("name") ?? ""),
        url: String(form.get("url") ?? ""),
        enabled: form.get("enabled") === "on"
      });
      setBanner({ notice: payload.notice, error: null });
      applyAdminPayload(payload.admin);
    } catch (error) {
      setBanner({ notice: null, error: error instanceof Error ? error.message : "Failed to update tracked item." });
    }
  }

  async function handleAdminItemDelete(trackedItemId: number, name: string) {
    if (!window.confirm(`Delete tracked item "${name}"?`)) {
      return;
    }

    try {
      const payload = await deleteAdminItem(trackedItemId);
      setBanner({ notice: payload.notice, error: null });
      applyAdminPayload(payload.admin);
    } catch (error) {
      setBanner({ notice: null, error: error instanceof Error ? error.message : "Failed to delete tracked item." });
    }
  }

  if (busy) {
    return <AppShell user={user}><div className="screen-center">Loading admin…</div></AppShell>;
  }

  const itemsByUserId = new Map<number, PlatformTrackedItem[]>();
  for (const item of items) {
    const group = itemsByUserId.get(item.ownerUserId);
    if (group) {
      group.push(item);
    } else {
      itemsByUserId.set(item.ownerUserId, [item]);
    }
  }

  return (
    <AppShell user={user}>
      <section className="page-header">
        <div>
          <p className="eyebrow">Admin</p>
          <h1>Platform administration</h1>
        </div>
      </section>
      <BannerBox banner={banner} />

      <section className="grid page-grid">
        <div className="panel">
          <h2>Tracker status</h2>
          <dl className="stats-list">
            <div><dt>Checks running</dt><dd>{trackerState.running ? "Yes" : "No"}</dd></div>
            <div><dt>Last run</dt><dd>{formatTimestamp(trackerState.lastRunAt)}</dd></div>
            <div><dt>Tracked items</dt><dd>{items.length}</dd></div>
          </dl>
        </div>
        <div className="panel">
          <h2>Scrape tracked items now</h2>
          <p className="muted">
            This runs the full scraper pipeline immediately for enabled items on the admin account, stores new check results,
            and records any scrape errors.
          </p>
          <button className="button primary" onClick={handleRunChecks}>Scrape admin account items now</button>
        </div>
      </section>

      {runSummary && (
        <section className="panel">
          <h2>Latest scrape run</h2>
          <dl className="stats-list">
            <div><dt>Items scraped</dt><dd>{runSummary.checked}</dd></div>
            <div><dt>Successful</dt><dd>{runSummary.successes}</dd></div>
            <div><dt>Errors</dt><dd>{runSummary.errors}</dd></div>
          </dl>
          <div className="history-block">
            <h4>Item results</h4>
            <ul>
              {runSummary.items.length === 0 ? (
                <li>No items were scraped.</li>
              ) : runSummary.items.map((entry) => (
                <li key={`${entry.trackedItemId}-${entry.checkedAt}`}>
                  <span>{entry.name}</span>
                  <span>
                    {entry.status === "ok"
                      ? `${formatPrice(entry.price, entry.currency)} at ${formatTimestamp(entry.checkedAt)}`
                      : `Error at ${formatTimestamp(entry.checkedAt)}: ${entry.errorMessage ?? "An error occurred"}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <section className="grid page-grid">
        <div className="panel">
          <h2>Send test email</h2>
          <form className="stack" onSubmit={handleEmail}>
            <label className="field">
              <span>Recipients</span>
              <textarea value={emailTargets} onChange={(event) => setEmailTargets(event.target.value)} rows={4} />
            </label>
            <button className="button primary">Send test email</button>
          </form>
        </div>
        <div className="panel">
          <h2>Send test Telegram</h2>
          <form className="stack" onSubmit={handleTelegram}>
            <label className="field">
              <span>Chat IDs</span>
              <textarea value={telegramTargets} onChange={(event) => setTelegramTargets(event.target.value)} rows={4} />
            </label>
            <button className="button primary">Send Telegram test</button>
          </form>
        </div>
      </section>

      <section className="panel">
        <h2>Scrape debug</h2>
        <form className="stack" onSubmit={handleScrapeDebug}>
          <label className="field">
            <span>URL</span>
            <input value={scrapeUrl} onChange={(event) => setScrapeUrl(event.target.value)} />
          </label>
          <button className="button primary">Fetch HTML</button>
        </form>
        {scrapeResult && (
          <div className="code-block large">
            <div><strong>Fetch mode:</strong> {scrapeResult.fetchMode ?? "n/a"}</div>
            <div><strong>Final URL:</strong> {scrapeResult.finalUrl ?? "n/a"}</div>
            <div><strong>Page title:</strong> {scrapeResult.pageTitle ?? "n/a"}</div>
            <div><strong>HTML bytes:</strong> {scrapeResult.htmlBytes ?? "n/a"}</div>
            <div><strong>Blocked message:</strong> {scrapeResult.blockedMessage ?? "n/a"}</div>
            <div><strong>Error:</strong> {scrapeResult.errorMessage ?? "n/a"}</div>
            <div><strong>Preferred region:</strong> {scrapeResult.inferredRegion ?? "n/a"}</div>
            <div><strong>Browser fallback suggested:</strong> {scrapeResult.browserFallbackSuggested == null ? "n/a" : scrapeResult.browserFallbackSuggested ? "yes" : "no"}</div>

            <h3>Localisation</h3>
            <div><strong>Accept-Language:</strong> {scrapeResult.scrapePreferences?.acceptLanguage ?? "n/a"}</div>
            <div><strong>Browser locale:</strong> {scrapeResult.scrapePreferences?.browserLocale ?? "n/a"}</div>
            <div><strong>Browser timezone:</strong> {scrapeResult.scrapePreferences?.browserTimezone ?? "n/a"}</div>

            <h3>Request headers</h3>
            <textarea
              readOnly
              rows={6}
              value={JSON.stringify(scrapeResult.requestHeaders, null, 2)}
            />

            <h3>Detection</h3>
            {scrapeResult.detection ? (
              <>
                <div><strong>Name:</strong> {scrapeResult.detection.name}</div>
                <div><strong>Detected price:</strong> {formatPrice(scrapeResult.detection.previewPrice, scrapeResult.detection.currency)}</div>
                <div><strong>Detection source:</strong> {scrapeResult.detection.detectionSource}</div>
                <div><strong>Raw text:</strong> {scrapeResult.detection.previewRawText}</div>
              </>
            ) : (
              <div>No price detection result.</div>
            )}

            <h3>Event log</h3>
            <textarea
              readOnly
              rows={10}
              value={scrapeResult.events.map((event) => `[${event.step}] ${event.detail}`).join("\n")}
            />

            <h3>HTML</h3>
            <textarea readOnly rows={18} value={scrapeResult.html ?? ""} />
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Users</h2>
        <div className="item-groups">
          {users.map((entry) => {
            const ownedItems = itemsByUserId.get(entry.id) ?? [];
            return (
              <details key={entry.id} className="item-group">
                <summary className="item-group-header">
                  <h3>{entry.email}</h3>
                  <span className="muted">
                    {entry.role} · {entry.isActive ? "active" : "disabled"} · {ownedItems.length} item{ownedItems.length === 1 ? "" : "s"}
                  </span>
                </summary>
                <div className="stack">
                  <form className="stack" onSubmit={(event) => void handleAdminUserSave(event, entry.id)}>
                    <div className="grid two">
                      <label className="field">
                        <span>First name</span>
                        <input name="firstName" defaultValue={entry.firstName} />
                      </label>
                      <label className="field">
                        <span>Last name</span>
                        <input name="lastName" defaultValue={entry.lastName} />
                      </label>
                    </div>
                    <div className="grid two">
                      <label className="field">
                        <span>Email</span>
                        <input name="email" type="email" defaultValue={entry.email} />
                      </label>
                      <label className="field">
                        <span>Role</span>
                        <select name="role" defaultValue={entry.role}>
                          <option value="user">user</option>
                          <option value="admin">admin</option>
                        </select>
                      </label>
                    </div>
                    <div className="grid two">
                      <label className="field checkbox-field">
                        <span>
                          <input name="isActive" type="checkbox" defaultChecked={entry.isActive} /> Active
                        </span>
                      </label>
                      <div className="field">
                        <span>Verified</span>
                        <div className="field-display">{entry.emailVerifiedAt ? formatTimestamp(entry.emailVerifiedAt) : "No"}</div>
                      </div>
                    </div>
                    <div className="hero-actions">
                      <button className="button primary" type="submit">Save user</button>
                      <button className="button danger" type="button" onClick={() => void handleAdminUserDelete(entry.id, entry.email)}>Delete user</button>
                    </div>
                  </form>

                  <div className="history-block">
                    <h4>User items</h4>
                    {ownedItems.length === 0 ? (
                      <p className="muted">No tracked items.</p>
                    ) : (
                      <div className="stack">
                        {ownedItems.map((item) => (
                          <form key={item.id} className="stack" onSubmit={(event) => void handleAdminItemSave(event, item.id)}>
                            <div className="grid two">
                              <label className="field">
                                <span>Name</span>
                                <input name="name" defaultValue={item.name} />
                              </label>
                              <label className="field">
                                <span>URL</span>
                                <input name="url" defaultValue={item.url} />
                              </label>
                            </div>
                            <div className="grid two">
                              <div className="field">
                                <span>Latest price</span>
                                <div className="field-display">{item.latestPrice ?? "N/A"}</div>
                              </div>
                              <div className="field">
                                <span>Status</span>
                                <div className="field-display">{item.latestStatus ?? "Unknown"}</div>
                              </div>
                            </div>
                            <div className="grid two">
                              <label className="field checkbox-field">
                                <span>
                                  <input name="enabled" type="checkbox" defaultChecked={item.enabled} /> Enabled
                                </span>
                              </label>
                              <div className="field">
                                <span>Last checked</span>
                                <div className="field-display">{formatTimestamp(item.latestCheckedAt)}</div>
                              </div>
                            </div>
                            <div className="hero-actions">
                              <button className="button primary" type="submit">Save item</button>
                              <button className="button danger" type="button" onClick={() => void handleAdminItemDelete(item.id, item.name)}>Delete item</button>
                            </div>
                          </form>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </details>
            );
          })}
        </div>
      </section>
    </AppShell>
  );
}

function AuthLayout({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="shell auth-shell">
      <div className="auth-card">
        <Link className="brand brand-link" to="/">PriceBuzz</Link>
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
}

function AppShell({ user, children }: { user: User; children: React.ReactNode }) {
  async function handleLogout() {
    await logout();
    window.location.replace("/");
  }

  return (
    <div className="shell app-shell">
      <header className="topbar">
        <div className="brand">PriceBuzz</div>
        <nav className="nav">
          <Link to="/app">Dashboard</Link>
          <Link to="/app/settings">Settings</Link>
          {user.role === "admin" && <Link to="/admin">Admin</Link>}
          <button className="ghost-button" onClick={() => void handleLogout()}>Log out</button>
        </nav>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}

function BannerBox({ banner }: { banner: Banner }) {
  if (!banner.notice && !banner.error) {
    return null;
  }

  return (
    <div className={`banner ${banner.error ? "error" : "notice"}`}>
      {banner.error ?? banner.notice}
    </div>
  );
}

function formatPrice(price: string | null, currency: string | null): string {
  if (!price) {
    return "N/A";
  }
  return currency ? `${currency} ${price}` : price;
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return "Never";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-NZ", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function siteLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Unknown site";
  }
}

function siteHomeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/`;
  } catch {
    return url;
  }
}

function sortableNumber(value: string | null | undefined): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function checkedTimestamp(item: TrackedItemWithHistory): number {
  const timestamp = Date.parse(item.latestCheck?.checkedAt ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function groupLabel(item: TrackedItemWithHistory, mode: ItemGroupMode): string {
  if (mode === "status") {
    return item.latestCheck?.status === "error" ? "Errors" : "Tracked";
  }
  if (mode === "currency") {
    return item.currency || "No currency";
  }
  if (mode === "site") {
    return siteLabel(item.url);
  }
  return "All items";
}

function groupAndSortItems(
  items: TrackedItemWithHistory[],
  sortMode: ItemSortMode,
  groupMode: ItemGroupMode
): Array<[string, TrackedItemWithHistory[]]> {
  const sorted = [...items].sort((left, right) => {
    if (sortMode === "name") {
      return left.name.localeCompare(right.name);
    }
    if (sortMode === "latest") {
      return sortableNumber(left.latestCheck?.price) - sortableNumber(right.latestCheck?.price);
    }
    if (sortMode === "lowest") {
      return sortableNumber(left.lowestPrice) - sortableNumber(right.lowestPrice);
    }
    return checkedTimestamp(right) - checkedTimestamp(left);
  });

  if (groupMode === "none") {
    return [["All items", sorted]];
  }

  const grouped = new Map<string, TrackedItemWithHistory[]>();
  for (const item of sorted) {
    const label = groupLabel(item, groupMode);
    if (!grouped.has(label)) {
      grouped.set(label, []);
    }
    grouped.get(label)!.push(item);
  }

  return [...grouped.entries()];
}

export default App;
