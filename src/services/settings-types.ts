// The shape of the server-persisted Settings blob (`AppSettings`) and the
// log-level vocabulary. Split out of settings.ts so runtime-config.ts can read
// the shape without importing settings.ts (which imports runtime-config.ts's
// resolvers) — see issue #2715. settings.ts re-exports everything here, so
// every existing importer keeps its path. Types plus the `LOG_LEVELS`
// constant: no defaults, no logic.

import { LOG_LEVELS, type LogLevel } from "../shared/constants.js";
export type { AppSettings } from "../shared/types.js";
export { LOG_LEVELS, type LogLevel };
