import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type * as SettingsModule from "../../src/services/settings.js";

// Unit-tests bundleSyncPlugin's own wiring in isolation — the boot-time
// dispatch logic itself (sync vs. remove, staleness, ...) is covered
// exhaustively against a real filesystem in test/services/bundle-sync.test.ts.
// This file deliberately does NOT use buildApp()/buildTestApp(): this
// plugin's `onReady` hook does real os.homedir()-based filesystem I/O
// (~/.mullion/bundle-sync.json, ~/.claude/skills, ...), and buildApp()
// always runs under NODE_ENV=test (test/setup.ts), so the only way to
// exercise the "plugin actually registers and dispatches" path at all is to
// flip NODE_ENV off for a moment — doing that against the real service
// would touch this developer's or CI runner's own home directory. Instead,
// bundle-sync.ts itself is mocked at the module boundary, and this test
// only asserts *which* function it's called with, against a bare `Fastify()`
// instance with a hand-stubbed `app.db`/absent `app.db` (the two shapes
// primary vs. agent role actually produce — see readInjectMullionBundle's
// own comment on that fallback) — never the real thing.
const runBundleSyncExclusiveMock = vi.fn(async () => ({ changed: true }));
vi.mock("../../src/services/bundle-sync.js", () => ({
  runBundleSyncExclusive: (enabled: boolean) => runBundleSyncExclusiveMock(enabled),
}));

const getStoredSettingsMock = vi.fn();
vi.mock("../../src/services/settings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof SettingsModule>();
  return {
    ...actual,
    getStoredSettings: (db: unknown) => getStoredSettingsMock(db),
  };
});

// Issue #1089 — the agent-role (no app.db) branch now consults this
// module's own persisted flag instead of blindly falling back to
// DEFAULT_SETTINGS (always `true`) — see plugins/bundle-sync.ts's own
// readInjectMullionBundle comment. Mocked at the module boundary for the
// same reason bundle-sync.ts itself is: this module's real read function
// does os.homedir()-based filesystem I/O.
const readAgentBundleDisabledMock = vi.fn(() => false);
vi.mock("../../src/services/agent-bundle-state.js", () => ({
  readAgentBundleDisabled: () => readAgentBundleDisabledMock(),
}));

const { bundleSyncPlugin } = await import("../../src/plugins/bundle-sync.js");

const originalNodeEnv = process.env.NODE_ENV;

/** The onReady hook is fire-and-forget (`void runBundleSync(app).catch(...)`,
 * see the plugin's own comment on why) — its synchronous prefix (calling
 * `runBundleSyncExclusive`) has already run by the time the hook itself
 * returns, but a tick is given anyway so this test doesn't depend on that
 * timing detail holding forever. */
async function settleMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("bundleSyncPlugin", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    runBundleSyncExclusiveMock.mockClear();
    getStoredSettingsMock.mockReset();
    readAgentBundleDisabledMock.mockClear();
    readAgentBundleDisabledMock.mockReturnValue(false);
    app = Fastify();
  });

  afterEach(async () => {
    await app.close();
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it("registers no onReady hook at all under NODE_ENV=test — the boot-time sync never runs", async () => {
    process.env.NODE_ENV = "test";
    await app.register(bundleSyncPlugin);
    await app.ready();
    await settleMicrotasks();
    expect(runBundleSyncExclusiveMock).not.toHaveBeenCalled();
  });

  it("agent-role shape (no app.db): consults its own persisted flag (not disabled) and syncs (enabled)", async () => {
    process.env.NODE_ENV = "production";
    readAgentBundleDisabledMock.mockReturnValue(false);
    // No app.db decoration at all — mirrors an agent-role process, which
    // never registers dbPlugin (see app.ts's own comment on that branch).
    await app.register(bundleSyncPlugin);
    await app.ready();
    await settleMicrotasks();
    expect(runBundleSyncExclusiveMock).toHaveBeenCalledWith(true);
    expect(getStoredSettingsMock).not.toHaveBeenCalled();
    expect(readAgentBundleDisabledMock).toHaveBeenCalled();
  });

  // Issue #1089 — the exact bug this fix closes: before it, this branch
  // fell back to DEFAULT_SETTINGS.sessions.injectMullionBundle (always
  // `true`), so an agent host that had just been told to remove bundle
  // content (routes/bundle-sync.ts's `/remove` fan-out) would silently
  // reinstall it all again on its very next boot.
  it("agent-role shape (no app.db): consults its own persisted flag (disabled) and dispatches to removal", async () => {
    process.env.NODE_ENV = "production";
    readAgentBundleDisabledMock.mockReturnValue(true);
    await app.register(bundleSyncPlugin);
    await app.ready();
    await settleMicrotasks();
    expect(runBundleSyncExclusiveMock).toHaveBeenCalledWith(false);
    expect(getStoredSettingsMock).not.toHaveBeenCalled();
  });

  it("primary-role shape (app.db present) with the setting on: dispatches to sync", async () => {
    process.env.NODE_ENV = "production";
    getStoredSettingsMock.mockReturnValue({ sessions: { injectMullionBundle: true } });
    (app as unknown as { db: unknown }).db = {};
    await app.register(bundleSyncPlugin);
    await app.ready();
    await settleMicrotasks();
    expect(getStoredSettingsMock).toHaveBeenCalled();
    expect(runBundleSyncExclusiveMock).toHaveBeenCalledWith(true);
  });

  it("primary-role shape with the setting off: dispatches to the removal branch", async () => {
    process.env.NODE_ENV = "production";
    getStoredSettingsMock.mockReturnValue({ sessions: { injectMullionBundle: false } });
    (app as unknown as { db: unknown }).db = {};
    await app.register(bundleSyncPlugin);
    await app.ready();
    await settleMicrotasks();
    expect(runBundleSyncExclusiveMock).toHaveBeenCalledWith(false);
  });

  it("a thrown/rejected boot sync is swallowed — never crashes boot (the .catch() is load-bearing)", async () => {
    process.env.NODE_ENV = "production";
    runBundleSyncExclusiveMock.mockRejectedValueOnce(new Error("disk full"));
    await app.register(bundleSyncPlugin);
    await expect(app.ready()).resolves.toBeDefined();
    await settleMicrotasks();
    expect(runBundleSyncExclusiveMock).toHaveBeenCalled();
  });
});
