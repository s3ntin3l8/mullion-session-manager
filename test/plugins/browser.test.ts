import { describe, it, expect, vi, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { buildTestApp } from "../helpers/app.js";
import { pendingBrowserCloses, projects } from "../../src/db/schema.js";
import { PENDING_CLOSE_RETRY_INTERVAL_MS } from "../../src/plugins/browser.js";
import { RemoteHostClient } from "../../src/services/remote-host-client.js";
import { AGENT_OPERATIONS, PROTOCOL_VERSION } from "../../src/shared/agent-protocol.js";

// buildApp() constructs a real BrowserManager (src/plugins/browser.ts), but
// never launches anything eagerly — only getOrLaunch() (driven here) hits
// Playwright, so it's faked the same way test/services/browser-manager.test.ts
// fakes it. Never launch a real Chromium in a unit test.
class FakeBrowser extends EventEmitter {
  connected = true;
  async newContext() {
    return {
      newPage: async () => new EventEmitter(),
      close: async () => {},
      storageState: async () => ({ cookies: [], origins: [] }),
    };
  }
  isConnected() {
    return this.connected;
  }
  async close() {
    this.connected = false;
  }
}

vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn(async () => new FakeBrowser()),
  },
}));

const TARGET = { projectId: 1, hostId: "local", checkoutRoot: "/x", legacy: true };

describe("browser plugin", () => {
  let dataDir: string;

  afterEach(() => {
    delete process.env.BROWSER_ENABLED;
    delete process.env.BROWSER_DATA_DIR;
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("decorates app.browser, disabled by default", async () => {
    const app = await buildTestApp();
    expect(app.browser).toBeDefined();
    expect(app.browser.isEnabled()).toBe(false);
    await expect(app.browser.getOrLaunch(TARGET)).rejects.toThrow(/disabled/i);
  });

  it("closes every pooled browser on app close when enabled", async () => {
    dataDir = path.join(
      os.tmpdir(),
      `browser-plugin-test-${crypto.randomBytes(4).toString("hex")}`,
    );
    process.env.BROWSER_ENABLED = "true";
    process.env.BROWSER_DATA_DIR = dataDir;

    const app = await buildTestApp();
    expect(app.browser.isEnabled()).toBe(true);
    await app.browser.getOrLaunch(TARGET);
    expect(app.browser.instanceCount).toBe(1);

    // Asserted on directly below (post-close pool state), not just
    // best-effort cleanup — kept explicit even though buildTestApp() would
    // also close this at test end.
    await app.close();
    expect(app.browser.instanceCount).toBe(0);
  });

  it("retries queued remote closes on a timer even though the primary's own browser is off (#2687)", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const app = await buildTestApp();
    expect(app.browser.isEnabled()).toBe(false);
    const timer = setIntervalSpy.mock.calls.find((c) => c[1] === PENDING_CLOSE_RETRY_INTERVAL_MS);
    expect(timer).toBeDefined();

    const host = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "retry-host", baseUrl: "http://127.0.0.1:1", token: "t".repeat(24) },
    });
    const hostId = host.json().id as string;
    app.hostAgentTracker?.record(hostId, {
      agents: null,
      capabilities: null,
      mullionVersion: null,
      protocol: {
        protocolVersion: PROTOCOL_VERSION,
        legacy: false,
        operations: [...AGENT_OPERATIONS],
        launchOptions: [],
      },
    });
    const projectId = app.db
      .insert(projects)
      .values({ name: "retry-p", cwd: "/work/p", hostId: "local" })
      .returning({ id: projects.id })
      .get().id;
    app.db
      .insert(pendingBrowserCloses)
      .values({ projectId, hostId, checkoutRoot: "/work/p", nextAttemptAt: new Date(0) })
      .run();
    const post = vi.spyOn(RemoteHostClient.prototype, "postBrowser").mockResolvedValue({});

    (timer![0] as () => void)();
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/internal/browser/close",
        expect.objectContaining({ projectId, hostId, checkoutRoot: "/work/p" }),
      ),
    );
    await vi.waitFor(() =>
      expect(app.db.select().from(pendingBrowserCloses).all()).toHaveLength(0),
    );
    setIntervalSpy.mockRestore();
    vi.restoreAllMocks();
  });
});
