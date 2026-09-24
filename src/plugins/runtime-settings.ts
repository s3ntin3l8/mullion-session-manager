import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { resolveLogLevel } from "../services/runtime-config.js";
import { getStoredSettings } from "../services/settings.js";

// Applies the Settings → Server log level once the DB is available. The
// loggingPlugin sets LOG_LEVEL earlier in boot; this lets a saved override
// win. Later changes are applied live by applySettingsPatch.
export const runtimeSettingsPlugin = fp(async (app: FastifyInstance) => {
  app.addHook("onReady", () => {
    const level = resolveLogLevel(getStoredSettings(app.db), app);
    if (app.log.level !== level) {
      app.log.level = level;
      app.log.info({ level }, "Log level set from settings");
    }
  });
});
