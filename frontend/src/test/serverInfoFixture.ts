import type { ServerInfo } from "../api/index.js";
import { FALLBACK_RUNTIME_ENV, FALLBACK_TASK_MASTER_ENV } from "../store/index.js";

// A complete /api/server-info response for tests that render a Settings
// section which reads server defaults or feature flags.
export const SERVER_INFO_FIXTURE: ServerInfo = {
  version: "0.1.0",
  role: "primary",
  nodeEnv: "test",
  port: 3000,
  encryptionEnabled: false,
  sessionsDir: "/tmp/sessions",
  dbPath: "/tmp/app.db",
  uptimeSeconds: 1,
  rateLimit: { max: 100, window: "1 minute" },
  projectsRoots: "",
  crsConfigDir: "~/.config/crs",
  previewsEnabled: false,
  previewBaseHost: "",
  previewAuthRequired: false,
  taskMasterEnabled: false,
  taskMasterEnv: FALLBACK_TASK_MASTER_ENV,
  runtimeEnv: FALLBACK_RUNTIME_ENV,
  running: { browserMaxInstances: 4, deviceDiscoveryEnabled: true },
  features: { browser: true, devices: true, deviceDiscovery: true },
};
