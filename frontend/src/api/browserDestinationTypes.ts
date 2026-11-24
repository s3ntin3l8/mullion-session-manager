// #3003 — the Browser pane's quick pick. Kept out of types.ts, which is at its
// size ceiling.

/** #3003 — one entry of the Browser pane's quick pick
 * (GET /api/projects/:id/browser-destinations, services/browser-destinations.ts). */
export interface BrowserDestination {
  key: string;
  group: "running" | "saved";
  kind: "dev-server" | "dock" | "compose" | "target" | "branch";
  label: string;
  detail: string | null;
  /** The address as seen from `hostId`; null when there is none. */
  address: string | null;
  /** Where `localhost` in `address` points. */
  hostId: string;
  previewSlug: string | null;
  targetId: string | null;
}

export interface BrowserDestinations {
  destinations: BrowserDestination[];
  /** Why the running group is empty or incomplete, or null. */
  runningNote: string | null;
  /** With `?sessionId=`: the host that session's browser runs on, or why it
   * cannot be told; null without the query. */
  agentBrowser?: { hostId: string | null; reason: string | null } | null;
}
