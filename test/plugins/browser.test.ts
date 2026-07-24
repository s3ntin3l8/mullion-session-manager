import { describe, it, expect, vi, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

// buildApp() constructs a real BrowserManager (src/plugins/browser.ts), but
// never launches anything eagerly — only getOrLaunch() (driven here) hits
// Playwright, so it's faked the same way test/services/browser-manager.test.ts
// fakes it. Never launch a real Chromium in a unit test.
class FakeBrowser extends EventEmitter {
  connected = true;
  async newContext() {
    return {
      newPage: async () => ({}),
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

const { buildApp } = await import("../../src/app.js");

describe("browser plugin", () => {
  let dataDir: string;

  afterEach(() => {
    delete process.env.BROWSER_ENABLED;
    delete process.env.BROWSER_DATA_DIR;
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("decorates app.browser, disabled by default", async () => {
    const app = await buildApp();
    expect(app.browser).toBeDefined();
    expect(app.browser.isEnabled()).toBe(false);
    await expect(app.browser.getOrLaunch(1)).rejects.toThrow(/disabled/i);
    await app.close();
  });

  it("closes every pooled browser on app close when enabled", async () => {
    dataDir = path.join(
      os.tmpdir(),
      `browser-plugin-test-${crypto.randomBytes(4).toString("hex")}`,
    );
    process.env.BROWSER_ENABLED = "true";
    process.env.BROWSER_DATA_DIR = dataDir;

    const app = await buildApp();
    expect(app.browser.isEnabled()).toBe(true);
    await app.browser.getOrLaunch(1);
    expect(app.browser.instanceCount).toBe(1);

    await app.close();
    expect(app.browser.instanceCount).toBe(0);
  });
});
