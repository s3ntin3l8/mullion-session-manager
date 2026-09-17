import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { DeviceManager } from "../services/device-manager.js";
import { devices } from "../db/schema.js";
import { ensureSessionsDir } from "./pty.js";

// Decorates app.device with the emulator/adb-scrcpy manager (see
// src/services/device-manager.ts). Modeled on src/plugins/browser.ts:
// registers regardless of DEVICE_ENABLED — the manager itself stays inert
// (every method throws) when the flag is off, so callers get a clear,
// consistent error rather than a missing decorator.
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

  app.addHook("onClose", async () => {
    await manager.killAll();
  });
});

declare module "fastify" {
  interface FastifyInstance {
    device: DeviceManager;
  }
}
