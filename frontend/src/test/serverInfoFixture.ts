import type { ServerInfo } from "../api/index.js";
import { makeServerInfo } from "./fixtures.js";

// A complete /api/server-info response for tests that render a Settings
// section which reads server defaults or feature flags.
export const SERVER_INFO_FIXTURE: ServerInfo = makeServerInfo();
