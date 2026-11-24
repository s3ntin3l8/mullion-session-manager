import type { GitRequest } from "./remote-host-git.js";

// The `/internal/dock-*` request builders of RemoteHostClient (issue #3426;
// convention in remote-host-git.ts). Each takes the client's own `request`
// (bound), so every call still goes through RemoteHostTransport.

/** What the agent's port probe answers for a conflict (null = none). */
export interface DockPortCheckAnswer {
  port: number;
  /** The agent-side session whose output announced the port; its pty id is the
   * primary's session id. */
  holderSessionId?: number;
}

/** A loopback bind probe plus a scan of live sessions: well under a second. */
const DOCK_PORT_CHECK_TIMEOUT_MS = 10_000;

export function resolveDockPortCheck(
  request: GitRequest,
  body: { cwd: string; command: string; devServerUrl: string | null },
): Promise<DockPortCheckAnswer | null> {
  return request(
    "/internal/dock-port-check",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    DOCK_PORT_CHECK_TIMEOUT_MS,
  );
}
