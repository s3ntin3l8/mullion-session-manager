import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { DeviceManager, isDevicePanelSupported } from "../services/device-manager.js";
import { DeviceDiscoveryService } from "../services/device-discovery.js";
import { devices } from "../db/schema.js";
import { resolveSessionsDirs } from "./pty.js";
import {
  resolveDeviceDiscoveryEnabled,
  resolveDeviceEmulatorLaunch,
} from "../services/runtime-config.js";
import { DEFAULT_SETTINGS, getStoredSettings } from "../services/settings.js";

// Decorates app.device with the emulator/adb-scrcpy manager (see
// src/services/device-manager.ts). Modeled on src/plugins/browser.ts:
// registers regardless of DEVICE_ENABLED — the manager itself stays inert
// (every method throws) when the flag is off, so callers get a clear,
// consistent error rather than a missing decorator.

// Read synchronously (better-sqlite3, no async gap between this and
// `new DeviceManager()` below) so allocatePort()'s round-robin scan can
// never run before these ports are reserved — see
// DeviceManagerOptions.initialPorts's own comment. `undefined` app.db (the
// multi-host "agent" role, which registers this plugin too — see
// src/app.ts's role branch) means no `devices` table to read at all, same
// `app.db ? ... : ` fallback posture as hooksPlugin's own settings lookup
// (src/plugins/hooks.ts).
function readActiveDevicePorts(app: FastifyInstance): number[] {
  if (!app.db) return [];
  return app.db
    .select({ port: devices.port })
    .from(devices)
    .where(eq(devices.status, "active"))
    .all()
    .map((row) => row.port)
    .filter((port): port is number => port !== null);
}

export const devicePlugin = fp(async (app: FastifyInstance) => {
  // Issue #1720 (roadmap 8.6) — the device panel is LINUX-ONLY, and this is
  // the one place that decides it. The panel's emulator scope needs
  // `systemd-run --user --scope` to start, to read liveness from, and to tear
  // down (device-process.ts); macOS has no equivalent, and the darwin
  // ScopeBackend cannot stand in because it is keyed to a SESSION's dtach
  // socket. A macOS device scope is tracked separately.
  //
  // So the panel is gated OFF on a platform that cannot support it, and the
  // gate says WHY: every route that ADDS, STARTS or CHANGES a device
  // answers 400 with "the device panel is not supported on darwin (it is
  // Linux-only)" instead of the raw `spawn systemctl ENOENT` a macOS
  // operator would otherwise hit. The /api/devices READS and the TEARDOWN
  // routes stay open on purpose — they were never gated on DEVICE_ENABLED
  // either, and an operator must be able to stop a device even where the
  // panel cannot create one.
  //
  // The platform is read HERE, at registration time, not at module load —
  // the same posture getScopeBackend() takes (src/services/scope/index.ts),
  // and the reason a test can exercise the gate on any host by stubbing
  // process.platform (see test/services/scope.test.ts's own darwin case).
  const platform = process.platform;
  const panelSupported = isDevicePanelSupported(platform);
  // The EFFECTIVE gate — the operator's DEVICE_ENABLED flag AND the
  // platform's ability to run the panel at all. Every device route checks
  // THIS, so the panel is off in one place and the reason for it is said in
  // one place.
  const panelEnabled = app.config.DEVICE_ENABLED && panelSupported;
  // Why the panel is unavailable, when it is. The platform reason DOMINATES:
  // telling a macOS operator to set DEVICE_ENABLED=true would send them off
  // to change a .env and restart for nothing.
  const panelUnavailableMessage = panelSupported
    ? "Device panel is disabled — set DEVICE_ENABLED=true."
    : `The device panel is not supported on ${platform} — it is Linux-only.`;
  if (!panelSupported) {
    app.log.info(
      { platform },
      "[device] the device panel is not supported on this platform — it is Linux-only, and the panel stays off",
    );
  }
  app.decorate("devicePanelEnabled", panelEnabled);
  app.decorate("devicePanelSupported", panelSupported);
  app.decorate("devicePanelUnavailableMessage", panelUnavailableMessage);

  // Issue #1770 — resolved ONCE, here: the dir the sockets live in and the
  // set of dirs this instance may own scopes in (the current one plus every
  // fallback root an earlier release shipped for the same configured path).
  // Same input, same pure function pty.ts's own plugin already calls — see
  // ensureSessionsDir's own comment on why this must match exactly.
  //
  // Issue #1771 — the install root rides along so the resolver's trail of
  // the dirs this install has resolved applies here too: a device scope
  // created before the sessions dir moved stays this instance's own,
  // without a second mechanism for the device path. The history warning is
  // not reported here: pty.ts's plugin registers FIRST (see src/app.ts) and
  // says it once.
  const sessionsDirs = resolveSessionsDirs(app.config.SESSIONS_DIR, {
    mullionHome: app.config.MULLION_HOME,
  });
  const manager = new DeviceManager({
    // A NARROWING, never a widening: `enabled` can only ever turn the panel
    // OFF on a platform it was already off by default on. Linux is unchanged.
    enabled: app.config.DEVICE_ENABLED && panelSupported,
    supported: panelSupported,
    adbPath: app.config.DEVICE_ADB_PATH,
    adbServerPort: app.config.DEVICE_ADB_SERVER_PORT,
    emulatorPath: app.config.DEVICE_EMULATOR_PATH,
    scrcpyServerPath: app.config.DEVICE_SCRCPY_SERVER_PATH,
    videoMaxSize: app.config.DEVICE_VIDEO_MAX_SIZE,
    videoMaxFps: app.config.DEVICE_VIDEO_MAX_FPS,
    videoBitRate: app.config.DEVICE_VIDEO_BIT_RATE,
    emulatorGpu: app.config.DEVICE_EMULATOR_GPU,
    // Settings → Devices can override the env default. Read here, on every
    // spawn, rather than once at boot: a window/GPU change should apply the
    // next time an emulator starts. DeviceManager still never touches app.db
    // itself — this callback is the same seam as onPortAssigned.
    resolveEmulatorLaunch: () =>
      resolveDeviceEmulatorLaunch(app.db ? getStoredSettings(app.db) : DEFAULT_SETTINGS, app),
    sessionsDir: sessionsDirs.current,
    // Issue #1770 — the ownership SET, so a device scope created before the
    // sessions dir moved is still this instance's own.
    ownedDirs: new Set(sessionsDirs.owned),
    initialPorts: readActiveDevicePorts(app),
    onSpawnError: (id, err) => {
      app.log.warn({ err, deviceId: id }, "device spawn failed");
    },
    // DeviceManager deliberately never touches app.db itself (see
    // DeviceManagerOptions' own header comment) — this is the one place
    // that crosses that line, wired here rather than per-route since the
    // manager (and this callback) are constructed once, here. See
    // onPortAssigned's own comment on why this fires immediately rather
    // than after boot succeeds.
    onPortAssigned: (id, port) => {
      app.db
        .update(devices)
        .set({ port })
        .where(eq(devices.id, Number(id)))
        .run();
    },
  });

  app.decorate("device", manager);

  // Companion to the manager: the mDNS scanner that surfaces nearby
  // Android phones in wireless-debugging mode (issue #1378). Gated on
  // DEVICE_ENABLED AND DEVICE_DISCOVERY_ENABLED — a deployment that never
  // enabled the device panel (the default) gets neither the manager nor
  // the scanner, so no multicast socket binds and no 5353 queries are
  // emitted on a Mullion install that has no business listening for them.
  // `DEVICE_DISCOVERY_ENABLED` is the boot-time default; a Settings override
  // is read here (after dbPlugin) and applies after a restart.
  const discoveryEnabled = resolveDeviceDiscoveryEnabled(
    app.db ? getStoredSettings(app.db) : DEFAULT_SETTINGS,
    app,
  );
  app.decorate("bootDeviceDiscoveryEnabled", discoveryEnabled);
  const discovery = new DeviceDiscoveryService({
    // Gated on the platform too: the mDNS scanner is the device panel's
    // companion, so a platform whose panel is off must not bind a
    // multicast socket or emit 5353 queries either.
    enabled: app.config.DEVICE_ENABLED && discoveryEnabled && panelSupported,
  });
  discovery.start();
  app.decorate("deviceDiscovery", discovery);

  app.addHook("onClose", async () => {
    await manager.killAll();
    discovery.stop();
  });
});

declare module "fastify" {
  interface FastifyInstance {
    device: DeviceManager;
    deviceDiscovery: DeviceDiscoveryService;
    /** Discovery flag this process booted with (env default or Settings override). */
    bootDeviceDiscoveryEnabled: boolean;
    /**
     * Whether the device panel is USABLE here — the operator's DEVICE_ENABLED
     * flag AND the platform's ability to run the panel at all (issue #1720:
     * the panel is Linux-only, because its emulator scope needs systemd).
     *
     * Every device route gates on this rather than on app.config directly, so
     * the panel is off in exactly one place.
     */
    devicePanelEnabled: boolean;
    /** Why the panel is unavailable, when it is — the platform reason first. */
    devicePanelUnavailableMessage: string;
    /**
     * Whether this PLATFORM supports the device panel at all. Distinct from
     * `devicePanelEnabled` (the effective gate) so a surface with its own
     * message shape can keep it and still report the platform reason.
     */
    devicePanelSupported: boolean;
  }
}
