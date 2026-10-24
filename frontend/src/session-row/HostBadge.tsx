import type { Host } from "../api/index.js";
// LOCAL_HOST_ID comes from the shared constants module, NOT through
// ../api/index.js: that module re-exports it, but a test that partially
// mocks the api module (PaneTab.test.tsx does) would then not have the
// export at all.
import { LOCAL_HOST_ID } from "../../../src/shared/constants.js";

// Issue #1727 / roadmap 8.13 — which host a session runs on.
//
// Quiet by design: a small badge, omitted entirely for a local session
// (the overwhelmingly common case), so the fleet only becomes visible when
// it is actually a fleet.
//
// The NAME, not the id: "mgmt" tells a user which machine; a UUID does not.
export function HostBadge({
  hostId,
  projectHostId,
  hosts,
}: {
  /** The session's own host, or null — which means "the project's host". */
  hostId: string | null;
  /** The project's host, for a session that does not have one of its own. */
  projectHostId?: string;
  hosts: readonly Host[] | undefined;
}): React.ReactElement | null {
  const resolved = hostId ?? projectHostId;
  if (resolved === undefined || resolved === LOCAL_HOST_ID) return null;
  const host = hosts?.find((h) => h.id === resolved);
  if (!host) return null;
  return (
    <span className="session-host-badge" title={`Runs on host: ${host.name}`}>
      {host.name}
    </span>
  );
}
