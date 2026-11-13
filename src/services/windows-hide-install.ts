// Side-effect module: patches `node:child_process` at import time. server.ts
// imports it first so the patch lands before any module-scope
// `promisify(execFile)` capture elsewhere in the graph. See
// windows-hide-children.ts.
import { installWindowsHideDefault } from "./windows-hide-children.js";

installWindowsHideDefault();
