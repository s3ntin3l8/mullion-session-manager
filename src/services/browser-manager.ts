import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { mkdirSync, existsSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

// Manages the Playwright Chromium that agents script via 3.2's WS frame stream
// and 3.5's automation API (Phase 3, issue #179): ONE Chromium process per
// machine (the primary, and separately each agent host, which runs its own
// manager) with one isolated BrowserContext per execution target. Distinct
// from the existing iframe-based BrowserPanel/preview-host proxy: that's an
// unauthenticated dev-server preview, this is a real browser this app drives.
//
// The process is launched lazily on the first getOrLaunch(target) and closed
// after the last target closes; a target's context is reused across pane
// open/close — closing the pane doesn't kill it, only closeTarget/
// closeForProject/closeAll do. This mirrors PtyManager's "spawned once, kept
// alive independent of viewer count" model (src/services/pty-manager.ts).
//
// Isolation is per context: each target has its own cookie jar, storage-state
// file and download directory. The one deliberate exception is the imported
// project cookie profile (`loadCookies`), which is project-scoped state and is
// applied to EVERY target of the project.

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
  /** Bounds the browser contexts (targets) held open in the shared Chromium
   * process — each is real host memory. Fed by BROWSER_MAX_INSTANCES. */
  maxContexts: number;
  /** Where per-project Playwright storage state (cookies/localStorage) is
   * persisted so a project's browser starts already-authenticated across
   * process restarts — see BROWSER_DATA_DIR in src/plugins/env.ts. */
  dataDir: string;
  /** Phase 3, issue #184 — optional hook returning a project's imported
   * browser cookies (src/services/browser-cookies.ts), applied to the
   * context on every launch (of every target of that project: the profile is
   * project-scoped, not target-isolated). Kept as an injected callback rather than this
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

/** Endpoint of a caller that names none (the project's single/default preview). */
export const LEGACY_BROWSER_ENDPOINT = "";

/** The execution target a browser belongs to (issue #2448): the project plus
 * the host, checkout and preview endpoint its work lives in. Two sessions on
 * the same target share one browser context (cookies, navigation, downloads);
 * a different host, checkout or endpoint gets its own, so a session placed elsewhere never inspects another
 * checkout's application. `localhost` in a page is interpreted by the machine
 * running the browser, which is the target's host. */
export interface BrowserTarget {
  projectId: number;
  hostId: string;
  /** Absolute checkout directory on `hostId` (a sibling worktree is its own). */
  checkoutRoot: string;
  /** The selected preview endpoint within the checkout; two previews of one
   * checkout get separate contexts. Absent for callers that have none, which
   * is `LEGACY_BROWSER_ENDPOINT`. */
  endpoint?: string;
  /** The project's default checkout on its default host: keeps the storage
   * state this project's browser had before targets existed (`project-<id>.json`)
   * instead of sharing it with unrelated checkouts. */
  legacy: boolean;
}

/** Stable pool key. A pool only ever holds contexts running on its own
 * machine (the primary's for its local host, each agent's for itself), so
 * checkout + endpoint identify the target within it; two hosts with the same
 * path live in different pools. NUL-separated so no path can collide with
 * another. */
export function browserTargetKey(target: BrowserTarget): string {
  return [target.projectId, target.checkoutRoot, target.endpoint ?? LEGACY_BROWSER_ENDPOINT].join(
    "\0",
  );
}

/** The query string naming a target on an agent's browser routes. */
export function browserTargetQuery(target: BrowserTarget): string {
  const { projectId, hostId, checkoutRoot } = target;
  const params = new URLSearchParams({
    projectId: String(projectId),
    hostId,
    checkoutRoot,
    legacy: target.legacy ? "1" : "0",
  });
  if (target.endpoint) params.set("endpoint", target.endpoint);
  return params.toString();
}

/** Short filesystem-safe id for a target's on-disk state. */
function targetFileId(target: BrowserTarget): string {
  // Only the endpoint-less legacy target keeps the unhashed id; endpoints in
  // the default checkout must not share storage or downloads.
  if (target.legacy && (!target.endpoint || target.endpoint === LEGACY_BROWSER_ENDPOINT)) {
    return `project-${target.projectId}`;
  }
  const digest = createHash("sha1").update(browserTargetKey(target)).digest("hex").slice(0, 16);
  return `project-${target.projectId}-${digest}`;
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
  target: BrowserTarget;
  /** The machine's shared Chromium process (not owned by this target). */
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** Set when the target's context is gone (closed, or the shared process
   * crashed); the entry is no longer in the pool, so holders see it as closed
   * rather than waiting on a dead page. */
  closed: boolean;
  /** Called once when `closed` flips, so a holder that streams from the page
   * (the browser panel's socket) can report "browser closed" instead of
   * waiting on frames that will never come. Fires immediately for a holder
   * that registers after the fact. */
  onClosed(listener: () => void): () => void;
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
  "Browser feature is disabled — turn it on in Settings → Browser (or set BROWSER_ENABLED=true), then restart the Mullion server.";

// Listeners live beside the entry, not on it, so ManagedBrowser stays a plain
// data shape that tests can construct.
const closeListeners = new WeakMap<ManagedBrowser, Set<() => void>>();

export class BrowserManager {
  private readonly enabled: boolean;
  private readonly maxContexts: number;
  private readonly dataDir: string;
  private readonly loadCookies?: (projectId: number) => LaunchCookie[] | Promise<LaunchCookie[]>;
  private readonly onCookieLoadError?: (projectId: number, err: unknown) => void;
  private readonly onDownloadError?: (projectId: number, err: unknown) => void;
  private readonly instances = new Map<string, ManagedBrowser>();
  // Targets whose context is being opened, so concurrent callers share one
  // launch and the pool bound counts them before they land in `instances`.
  private readonly pending = new Map<string, Promise<ManagedBrowser>>();
  // Targets whose context is being saved and closed. They are out of
  // `instances` but still occupy the shared process (and a pool slot), and a
  // relaunch of the same key must wait for the close: it would otherwise wipe
  // the downloads the old context is still saving and load a half-written
  // storage-state file.
  private readonly closing = new Map<string, Promise<void>>();
  // The machine's single Chromium process; null until the first target.
  private process: Browser | null = null;
  private processLaunch: Promise<Browser> | null = null;

  constructor(options: BrowserManagerOptions) {
    this.enabled = options.enabled;
    this.maxContexts = options.maxContexts;
    this.dataDir = options.dataDir;
    this.loadCookies = options.loadCookies;
    this.onCookieLoadError = options.onCookieLoadError;
    this.onDownloadError = options.onDownloadError;
    if (this.enabled) mkdirSync(this.dataDir, { recursive: true });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Open target contexts (not processes: see `processCount`). */
  get instanceCount(): number {
    return this.instances.size;
  }

  /** Chromium processes this manager has running: 0 or 1. */
  get processCount(): number {
    return this.process?.isConnected() ? 1 : 0;
  }

  get(target: BrowserTarget): ManagedBrowser | undefined {
    return this.instances.get(browserTargetKey(target));
  }

  /** Every running browser of a project, across its targets. */
  listForProject(projectId: number): ManagedBrowser[] {
    return [...this.instances.values()].filter((m) => m.projectId === projectId);
  }

  private storageStatePath(target: BrowserTarget): string {
    return path.join(this.dataDir, `${targetFileId(target)}.json`);
  }

  private downloadsDir(target: BrowserTarget): string {
    return path.join(this.dataDir, "downloads", targetFileId(target));
  }

  /** The shared Chromium, launched on first use and again after a crash or
   * once the last target closed it. */
  private async ensureProcess(): Promise<Browser> {
    if (this.process?.isConnected()) return this.process;
    if (!this.processLaunch) {
      this.processLaunch = chromium
        .launch({
          headless: true,
          // Unprivileged LXC/container hosts commonly block the user namespaces
          // Chromium's sandbox needs — see deploy/README.md's Playwright
          // prerequisites. This process already runs behind Mullion's own auth
          // gate, so the sandbox isn't this feature's only isolation boundary.
          args: ["--no-sandbox"],
        })
        .then((browser) => {
          this.process = browser;
          // Chromium dying unexpectedly (OOM-killed, segfault) fires
          // 'disconnected' same as a deliberate close(); a deliberate close
          // clears `this.process` first, so the identity check tells them apart.
          browser.on("disconnected", () => {
            if (this.process !== browser) return;
            this.process = null;
            this.dropContextsOf(browser);
          });
          return browser;
        })
        .finally(() => {
          this.processLaunch = null;
        });
    }
    return this.processLaunch;
  }

  /** Flips a pooled entry to closed and tells whoever is streaming from it. */
  private markClosed(managed: ManagedBrowser): void {
    if (managed.closed) return;
    managed.closed = true;
    const listeners = closeListeners.get(managed);
    closeListeners.delete(managed);
    for (const listener of listeners ?? []) {
      try {
        listener();
      } catch {
        // a holder's callback must not break the pool's own bookkeeping
      }
    }
  }

  /** The process is gone: every target on it is closed, and the next
   * getOrLaunch() relaunches. */
  private dropContextsOf(browser: Browser): void {
    for (const [key, managed] of this.instances) {
      if (managed.browser !== browser) continue;
      this.markClosed(managed);
      this.instances.delete(key);
    }
  }

  /** Closes the shared process once no target uses it or is being opened. */
  private async closeProcessIfIdle(): Promise<void> {
    if (this.instances.size > 0 || this.pending.size > 0 || this.closing.size > 0) return;
    const browser = this.process;
    if (!browser) return;
    this.process = null;
    await browser.close().catch(() => {});
  }

  /** Returns the pooled context/page for a target, opening it in the shared
   * Chromium (launched here if not running) on first access or after a crash.
   * Concurrent calls for the same target share one launch. */
  async getOrLaunch(target: BrowserTarget): Promise<ManagedBrowser> {
    if (!this.enabled) throw new Error(BROWSER_DISABLED_MESSAGE);

    const key = browserTargetKey(target);
    // A close of this very target is still saving: start clean after it.
    const closingNow = this.closing.get(key);
    if (closingNow) await closingNow;
    const existing = this.instances.get(key);
    if (existing && existing.browser.isConnected()) return existing;
    if (existing) {
      this.markClosed(existing);
      this.instances.delete(key);
    }

    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    const open = this.instances.size + this.pending.size + this.closing.size;
    if (open >= this.maxContexts) {
      throw new Error(
        `Browser pool exhausted: ${open}/${this.maxContexts} instances already running.`,
      );
    }

    const launch = this.openTarget(target, key).finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, launch);
    try {
      return await launch;
    } catch (err) {
      await this.closeProcessIfIdle();
      throw err;
    }
  }

  private async openTarget(target: BrowserTarget, key: string): Promise<ManagedBrowser> {
    // Issue #381 — the `downloads` array below (and the 50-entry eviction
    // that deletes files as they age out of it) is a plain closure variable,
    // scoped to THIS launch's lifetime. It has no memory of files saved by a
    // PRIOR instance for this same project — the moment this process
    // restarts (redeploy, this browser instance crashing and relaunching,
    // an operator restarting the service) or this project's browser is torn
    // down and later relaunched, any files that instance's eviction hadn't
    // yet gotten to become permanently untracked, since there's no
    // cross-restart index of what's still "live". Sweeping the directory
    // clean on every FRESH launch (never on the cache-hit reuse path above,
    // which already tracks its own files correctly) is what actually bounds
    // on-disk growth across restarts, not just within one browser
    // instance's own uptime.
    //
    // Awaited, not fire-and-forget: this runs before the page (and its
    // page.on("download") listener) even exists, so there's no download to
    // race yet — but making it fire-and-forget would create a WORSE race
    // instead, between this sweep's own unawaited rm() and a download that
    // completes shortly after this method returns: if the sweep is still
    // in flight when the download handler's mkdirSync+saveAs runs, the
    // sweep resolving afterward would delete the file it just legitimately
    // saved. Awaiting here keeps the sweep strictly ordered before the page
    // (and thus before any possible download) exists at all.
    await rm(this.downloadsDir(target), {
      recursive: true,
      force: true,
    }).catch(() => {});

    const browser = await this.ensureProcess();

    const storageStatePath = this.storageStatePath(target);
    const context = await browser.newContext(
      existsSync(storageStatePath) ? { storageState: storageStatePath } : {},
    );
    // The context lives in the shared process but is not in `instances` until
    // the target is fully open, so a failure from here on must close it or it
    // would stay there uncounted by `maxContexts`.
    try {
      return await this.finishOpen(target, key, browser, context);
    } catch (err) {
      await context.close().catch(() => {});
      throw err;
    }
  }

  private async finishOpen(
    target: BrowserTarget,
    key: string,
    browser: Browser,
    context: BrowserContext,
  ): Promise<ManagedBrowser> {
    const { projectId } = target;

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
      target,
      browser,
      context,
      page,
      closed: false,
      onClosed: (listener) => {
        if (managed.closed) {
          listener();
          return () => {};
        }
        let set = closeListeners.get(managed);
        if (!set) closeListeners.set(managed, (set = new Set()));
        set.add(listener);
        return () => {
          set.delete(listener);
        };
      },
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
        const dir = this.downloadsDir(target);
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

    this.instances.set(key, managed);
    return managed;
  }

  /** Health-check sweep: evicts the shared process and its targets if it
   * died without firing 'disconnected' yet (there's normally no gap, but this
   * is cheap, idempotent housekeeping — see the browser plugin's periodic
   * timer). Eviction is lazy: the next getOrLaunch() relaunches, rather than
   * proactively relaunching a browser nobody is currently viewing. */
  healthCheck(): void {
    const browser = this.process;
    if (browser && !browser.isConnected()) {
      this.process = null;
      this.dropContextsOf(browser);
    }
    for (const [key, managed] of this.instances) {
      if (!managed.browser.isConnected()) {
        this.markClosed(managed);
        this.instances.delete(key);
      }
    }
  }

  /** Persists storage state (cookies/localStorage) and closes one target's
   * context, if one is open; the last close shuts the shared process down.
   * Safe to call when none is open. */
  async closeTarget(target: BrowserTarget): Promise<void> {
    const key = browserTargetKey(target);
    const inFlight = this.closing.get(key);
    if (inFlight) return inFlight;
    const existing = this.instances.get(key);
    if (!existing) return;

    this.markClosed(existing);
    this.instances.delete(key);
    const close = this.saveAndClose(existing, target).finally(() => {
      this.closing.delete(key);
    });
    this.closing.set(key, close);
    await close;
    await this.closeProcessIfIdle();
  }

  private async saveAndClose(existing: ManagedBrowser, target: BrowserTarget): Promise<void> {
    try {
      if (existing.browser.isConnected()) {
        await existing.context.storageState({ path: this.storageStatePath(target) });
      }
    } catch {
      // Best-effort persistence — a context that's already gone (crash,
      // race with the 'disconnected' handler) simply skips this, same as
      // any other already-dead session's teardown.
    }
    await existing.context.close().catch(() => {});
  }

  /** Closes a target's browser and deletes the storage state and downloads it
   * left on disk. For a checkout that no longer exists: its cookies would
   * otherwise stay forever. The project-default target (`legacy`) keeps its
   * files — that checkout is not going away. */
  async forgetTarget(target: BrowserTarget): Promise<void> {
    await this.closeTarget(target);
    if (target.legacy) return;
    await rm(this.storageStatePath(target), { force: true });
    await rm(this.downloadsDir(target), { recursive: true, force: true });
  }

  /** `forgetTarget` for every target of one checkout: each running endpoint
   * plus the checkout's default-endpoint target, whose files may exist with
   * nothing running. (A stopped endpoint's file cannot be found: its name is a
   * one-way digest of the endpoint.) */
  async forgetCheckout(projectId: number, hostId: string, checkoutRoot: string): Promise<void> {
    const targets = new Map<string, BrowserTarget>();
    for (const managed of this.listForProject(projectId)) {
      if (managed.target.checkoutRoot === checkoutRoot) {
        targets.set(browserTargetKey(managed.target), managed.target);
      }
    }
    const base: BrowserTarget = { projectId, hostId, checkoutRoot, legacy: false };
    targets.set(browserTargetKey(base), base);
    for (const target of targets.values()) await this.forgetTarget(target);
  }

  /** Closes every target of a project (project deleted or merged
   * away). Safe to call when none is running. */
  async closeForProject(projectId: number): Promise<void> {
    await Promise.all(this.listForProject(projectId).map((m) => this.closeTarget(m.target)));
  }

  /** Closes every target and the shared process — called from the plugin's onClose hook. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.instances.values()].map((m) => this.closeTarget(m.target)));
    await this.closeProcessIfIdle();
  }
}
