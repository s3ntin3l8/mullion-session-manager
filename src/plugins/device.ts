import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { DeviceManager } from "../services/device-manager.js";
import { DeviceDiscoveryService } from "../services/device-discovery.js";
import { devices } from "../db/schema.js";
import { ensureSessionsDir } from "./pty.js";

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
  const manager = new DeviceManager({
    enabled: app.config.DEVICE_ENABLED,
    adbPath: app.config.DEVICE_ADB_PATH,
    adbServerPort: app.config.DEVICE_ADB_SERVER_PORT,
    emulatorPath: app.config.DEVICE_EMULATOR_PATH,
    scrcpyServerPath: app.config.DEVICE_SCRCPY_SERVER_PATH,
    // Same input, same pure function pty.ts's own plugin already calls —
    // see ensureSessionsDir's own comment on why this must match exactly.
    sessionsDir: ensureSessionsDir(app.config.SESSIONS_DIR),
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
  // Android phones in wireless-debugging mode (issue #1378). Independent of
  // DEVICE_ENABLED — discovery is a read-only LAN probe and stays useful
  // even when the rest of the device panel is off (the user can still see
  // what phones are out there before deciding to enable the feature).
  // Always constructed; start()/stop() are gated by DEVICE_DISCOVERY_ENABLED
  // inside the service itself so a disabled scanner never opens a UDP
  // socket. Started eagerly (mDNS discovery is silent and adds no
  // protocol surface); torn down in onClose alongside the manager.
  const discovery = new DeviceDiscoveryService({
    enabled: app.config.DEVICE_DISCOVERY_ENABLED,
    intervalMs: app.config.DEVICE_DISCOVERY_INTERVAL_MS,
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
  }
}
