import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { mkdirSync, existsSync } from "node:fs";
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
}

export interface ManagedBrowser {
  projectId: number;
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

const BROWSER_DISABLED_MESSAGE =
  "Browser feature is disabled — set BROWSER_ENABLED=true to enable the Playwright-driven browser pane (Phase 3, issue #179).";

export class BrowserManager {
  private readonly enabled: boolean;
  private readonly maxInstances: number;
  private readonly dataDir: string;
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
    const page = await context.newPage();

    const managed: ManagedBrowser = { projectId, browser, context, page };

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
