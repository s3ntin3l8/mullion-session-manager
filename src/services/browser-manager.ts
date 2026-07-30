import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { mkdirSync, existsSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import path from "node:path";

// Manages a pool of Playwright Chromium instances, one per project (Phase 3,
// issue #179) — the CDP-controllable browser agents script via 3.2's WS
// frame stream and 3.5's automation API. Distinct from the existing
// iframe-based BrowserPanel/preview-host proxy: that's an unauthenticated
// dev-server preview, this is a real browser process this app drives.
//
// An instance is launched lazily on first getOrLaunch(projectId) and reused
// across pane open/close — closing the pane doesn't kill the browser, only
// closeForProject/closeAll do. This mirrors PtyManager's "spawned once, kept
// alive independent of viewer count" model (src/services/pty-manager.ts).

/** Matches Playwright's own BrowserContext.addCookies() param shape exactly
 * (see src/services/browser-cookie-import.ts's ImportedCookie, which this
 * mirrors) — kept as a local structural type here so this file doesn't need
 * to import from that module just for a type. */
export interface LaunchCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly: boolean;
  secure: boolean;
}

export interface BrowserManagerOptions {
  /** Mirrors BROWSER_ENABLED — false makes every method throw rather than
   * silently no-op, so a misconfigured caller fails loudly instead of
   * quietly getting no browser. */
  enabled: boolean;
  /** Bounds concurrent Chromium processes — each is real host memory. */
  maxInstances: number;
  /** Where per-project Playwright storage state (cookies/localStorage) is
   * persisted so a project's browser starts already-authenticated across
   * process restarts — see BROWSER_DATA_DIR in src/plugins/env.ts. */
  dataDir: string;
  /** Phase 3, issue #184 — optional hook returning a project's imported
   * browser cookies (src/services/browser-cookies.ts), applied to the
   * context on every launch. Kept as an injected callback rather than this
   * class reaching into app.db directly, matching #179's original design:
   * BrowserManager is a pure, DB-agnostic service, independently testable —
   * see src/plugins/browser.ts for how this is actually wired to storage. */
  loadCookies?: (projectId: number) => LaunchCookie[] | Promise<LaunchCookie[]>;
  /** Optional — called when loadCookies (above) throws, so a caller with a
   * real logger (src/plugins/browser.ts) can record it. Never rethrown:
   * this stays best-effort regardless of whether a hook is provided, since
   * the common case (no imported profile yet) shouldn't block launching. */
  onCookieLoadError?: (projectId: number, err: unknown) => void;
  /** Issue #381 (3.10) — optional hook, invoked when saving a completed
   * download to disk fails (bad path, disk full, an eviction's own
   * best-effort file deletion failing, ...). A direct structural copy of
   * onCookieLoadError just above: this also runs inside a page.on("download")
   * event handler with no caller to propagate a throw to, so it's surfaced
   * via this callback instead (logged by src/plugins/browser.ts the same
   * way onCookieLoadError is wired there) rather than thrown or silently
   * swallowed. */
  onDownloadError?: (projectId: number, err: unknown) => void;
}

export interface ConsoleLogEntry {
  type: string;
  text: string;
  timestamp: number;
}

export interface PageErrorEntry {
  message: string;
  stack?: string;
  timestamp: number;
}

/** Issue #381 (3.10) — one completed, saved-to-disk download. `path` is a
 * host-local filesystem path — meaningless to a caller on a different host
 * than the one that actually ran this browser (see browser-automation.ts's
 * "download" action doc comment / docs/browser-automation.md's multi-host
 * caveat); `contents` (added by the route layer, not stored here) is the
 * actually-portable field. */
export interface DownloadEntry {
  filename: string;
  path: string;
  url: string;
  size: number;
  timestamp: number;
}

// Bounds the in-memory downloads buffer, same precedent as consoleLogs'/
// pageErrors' own caps just below — but unlike those (which just discard
// old strings when evicted), evicting a DownloadEntry must also delete the
// file it points to (see getOrLaunch's page.on("download") handler), or the
// on-disk downloads directory grows without bound even though the in-memory
// list itself stays capped.
const MAX_DOWNLOADS = 50;

export interface ManagedBrowser {
  projectId: number;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  consoleLogs: ConsoleLogEntry[];
  pageErrors: PageErrorEntry[];
  downloads: DownloadEntry[];
  dialogAction?: "accept" | "dismiss";
  dialogText?: string;
}

/** Strips path separators and `..` traversal segments from a page/site-
 * controlled filename (Download.suggestedFilename() — content the remote
 * page or a Content-Disposition header fully controls, not something this
 * app generates) before it's joined into a filesystem path. Falls back to a
 * fixed name if sanitizing leaves nothing usable. */
function sanitizeDownloadFilename(name: string): string {
  const stripped = name.replace(/[/\\]/g, "_").replace(/\.\.+/g, "_");
  return stripped.length > 0 ? stripped : "download";
}

const BROWSER_DISABLED_MESSAGE =
  "Browser feature is disabled — set BROWSER_ENABLED=true to enable the Playwright-driven browser pane (Phase 3, issue #179).";

export class BrowserManager {
  private readonly enabled: boolean;
  private readonly maxInstances: number;
  private readonly dataDir: string;
  private readonly loadCookies?: (projectId: number) => LaunchCookie[] | Promise<LaunchCookie[]>;
  private readonly onCookieLoadError?: (projectId: number, err: unknown) => void;
  private readonly onDownloadError?: (projectId: number, err: unknown) => void;
  private readonly instances = new Map<number, ManagedBrowser>();
  // Instances closeForProject/closeAll are actively tearing down — guards
  // the 'disconnected' listener below from re-deleting an entry that a
  // concurrent getOrLaunch() call has already replaced with a fresh one for
  // the same projectId.
  private readonly closing = new Set<number>();

  constructor(options: BrowserManagerOptions) {
    this.enabled = options.enabled;
    this.maxInstances = options.maxInstances;
    this.dataDir = options.dataDir;
    this.loadCookies = options.loadCookies;
    this.onCookieLoadError = options.onCookieLoadError;
    this.onDownloadError = options.onDownloadError;
    if (this.enabled) mkdirSync(this.dataDir, { recursive: true });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  get instanceCount(): number {
    return this.instances.size;
  }

  get(projectId: number): ManagedBrowser | undefined {
    return this.instances.get(projectId);
  }

  private storageStatePath(projectId: number): string {
    return path.join(this.dataDir, `project-${projectId}.json`);
  }

  /** Returns the pooled browser/context/page for a project, launching a
   * fresh Chromium instance on first access or after a crash. Not
   * re-entrant-safe for concurrent calls with the same projectId (callers —
   * the 3.2 WS route and 3.5 automation API — are expected to serialize per
   * session, matching how a single browser tab is used). */
  async getOrLaunch(projectId: number): Promise<ManagedBrowser> {
    if (!this.enabled) throw new Error(BROWSER_DISABLED_MESSAGE);

    const existing = this.instances.get(projectId);
    if (existing && existing.browser.isConnected()) return existing;
    if (existing) this.instances.delete(projectId);

    if (this.instances.size >= this.maxInstances) {
      throw new Error(
        `Browser pool exhausted: ${this.instances.size}/${this.maxInstances} instances already running.`,
      );
    }

    const browser = await chromium.launch({
      headless: true,
      // Unprivileged LXC/container hosts commonly block the user namespaces
      // Chromium's sandbox needs — see deploy/README.md's Playwright
      // prerequisites. This process already runs behind Mullion's own auth
      // gate, so the sandbox isn't this feature's only isolation boundary.
      args: ["--no-sandbox"],
    });

    const storageStatePath = this.storageStatePath(projectId);
    const context = await browser.newContext(
      existsSync(storageStatePath) ? { storageState: storageStatePath } : {},
    );

    // #184 — applied after context creation regardless of whether
    // storageState above already had cookies: addCookies() upserts by
    // name/domain/path, so a freshly (re-)imported profile always takes
    // precedence over whatever a stale storageState snapshot had.
    if (this.loadCookies) {
      try {
        const cookies = await this.loadCookies(projectId);
        if (cookies.length > 0) await context.addCookies(cookies);
      } catch (err) {
        // Best-effort — a project with no imported cookie profile (the
        // common case) or a decrypt failure shouldn't block launching the
        // browser itself. Still surfaced via onCookieLoadError (if wired)
        // rather than swallowed outright, so an unexpected failure (e.g. a
        // bug in addCookies) isn't invisible (Hermes review, PR #302).
        this.onCookieLoadError?.(projectId, err);
      }
    }

    const page = await context.newPage();

    const consoleLogs: ConsoleLogEntry[] = [];
    const pageErrors: PageErrorEntry[] = [];
    const downloads: DownloadEntry[] = [];

    const managed: ManagedBrowser = {
      projectId,
      browser,
      context,
      page,
      consoleLogs,
      pageErrors,
      downloads,
    };

    page.on("console", (msg) => {
      consoleLogs.push({
        type: msg.type(),
        text: msg.text(),
        timestamp: Date.now(),
      });
      if (consoleLogs.length > 1200) {
        consoleLogs.splice(0, 200);
      }
    });

    page.on("pageerror", (err) => {
      pageErrors.push({
        message: err.message,
        stack: err.stack,
        timestamp: Date.now(),
      });
      if (pageErrors.length > 1200) {
        pageErrors.splice(0, 200);
      }
    });

    // Issue #381 (3.10) — installed once, here, at launch time — NOT inside
    // the `download` action's own handler (src/routes/browser-automation.ts).
    // A download event fires during the PRECEDING action (e.g. a click on a
    // "Download CSV" button), not during a later `download` action call, so
    // a listener installed only when that action runs would frequently miss
    // it — the download may already be finished by the time an agent thinks
    // to ask about it. `acceptDownloads` defaults to `true` on
    // browser.newContext() (verified against the installed playwright
    // package's own types), so no context-option change is needed to permit
    // downloads — only this listener, to save the file out before
    // Playwright deletes its temp copy when the context closes.
    page.on("download", async (download) => {
      try {
        const dir = path.join(this.dataDir, "downloads", `project-${projectId}`);
        mkdirSync(dir, { recursive: true });
        const sanitized = sanitizeDownloadFilename(download.suggestedFilename());
        const savedPath = path.join(dir, `${Date.now()}-${sanitized}`);
        await download.saveAs(savedPath);
        const stats = await stat(savedPath).catch(() => null);
        downloads.push({
          filename: sanitized,
          path: savedPath,
          url: download.url(),
          size: stats?.size ?? 0,
          timestamp: Date.now(),
        });
        // Bounded buffer, same eviction precedent as consoleLogs/pageErrors
        // above (see MAX_DOWNLOADS' own comment for why eviction here must
        // also delete the evicted entry's file, unlike those two).
        if (downloads.length > MAX_DOWNLOADS) {
          const evicted = downloads.splice(0, downloads.length - MAX_DOWNLOADS);
          for (const entry of evicted) {
            await rm(entry.path, { force: true }).catch((err) => {
              this.onDownloadError?.(projectId, err);
            });
          }
        }
      } catch (err) {
        // Best-effort, same posture as loadCookies's own try/catch above:
        // this runs inside an event handler with no caller to propagate a
        // throw to — surfaced via onDownloadError (if wired) rather than
        // swallowed outright.
        this.onDownloadError?.(projectId, err);
      }
    });

    page.on("dialog", async (dialog) => {
      const action = managed.dialogAction;
      const text = managed.dialogText;
      if (action === "accept") {
        await dialog.accept(text).catch(() => {});
      } else if (action === "dismiss") {
        await dialog.dismiss().catch(() => {});
      } else {
        const type = dialog.type();
        if (type === "alert" || type === "confirm") {
          await dialog.accept().catch(() => {});
        } else {
          await dialog.dismiss().catch(() => {});
        }
      }
    });

    // Auto-restart on crash (#179): Chromium dying unexpectedly (OOM-killed,
    // segfault) fires 'disconnected' same as a deliberate close() — the
    // `closing` guard is what tells the two apart, since a caller in the
    // middle of tearing this instance down has already removed it from
    // `instances` and doesn't want this listener to race that removal for a
    // *different*, newer instance that might already occupy the same key.
    browser.on("disconnected", () => {
      if (this.closing.has(projectId)) return;
      if (this.instances.get(projectId) === managed) this.instances.delete(projectId);
    });

    this.instances.set(projectId, managed);
    return managed;
  }

  /** Health-check sweep: evicts any pooled entry whose underlying Chromium
   * process has died without firing 'disconnected' yet (there's normally no
   * gap, but this is cheap, idempotent housekeeping — see the browser
   * plugin's periodic timer). Eviction is lazy: a dead entry is dropped so
   * the next getOrLaunch() call relaunches it, rather than proactively
   * relaunching browsers nobody is currently viewing. */
  healthCheck(): void {
    for (const [projectId, managed] of this.instances) {
      if (!managed.browser.isConnected()) this.instances.delete(projectId);
    }
  }

  /** Persists storage state (cookies/localStorage) and closes the project's
   * browser, if one is running. Safe to call when none is running. */
  async closeForProject(projectId: number): Promise<void> {
    const existing = this.instances.get(projectId);
    if (!existing) return;

    this.closing.add(projectId);
    this.instances.delete(projectId);
    try {
      if (existing.browser.isConnected()) {
        await existing.context.storageState({ path: this.storageStatePath(projectId) });
      }
    } catch {
      // Best-effort persistence — a browser that's already gone (crash,
      // race with the 'disconnected' handler) simply skips this, same as
      // any other already-dead session's teardown.
    }
    await existing.browser.close().catch(() => {});
    this.closing.delete(projectId);
  }

  /** Closes every pooled browser — called from the plugin's onClose hook. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.instances.keys()].map((id) => this.closeForProject(id)));
  }
}
