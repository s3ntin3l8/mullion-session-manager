import { describe, it, expect } from "vitest";
import { describeHostBadge } from "./hostBadge.js";
import { makeHost } from "../test/fixtures.js";

// Issue #1852 — the per-session host badge and its tooltip. The two
// disagree in a way a reader would notice: the badge shows the host's
// NAME, while the placement decision names the host by its ID (a remote
// host's id is a UUID). The helper resolves both, in one place.

const HOSTS = [
  makeHost({ id: "mac-mini", name: "mac-mini" }),
  makeHost({ id: "3f2a9c1e-0000-4000-8000-000000000000", name: "studio-mac" }),
];

describe("describeHostBadge (issue #1852)", () => {
  it("is nothing for a LOCAL session — the per-project badge already says that", () => {
    expect(
      describeHostBadge({ resolvedHostId: "local", placementReason: "pinned to local" }, HOSTS),
    ).toBeNull();
  });

  it("names the host, by its DISPLAY name", () => {
    const badge = describeHostBadge(
      { resolvedHostId: "3f2a9c1e-0000-4000-8000-000000000000", placementReason: null },
      HOSTS,
    );
    expect(badge?.name).toBe("studio-mac");
  });

  it("falls back to the host id when the fleet list has no name for it", () => {
    const badge = describeHostBadge(
      { resolvedHostId: "unknown-host", placementReason: null },
      HOSTS,
    );
    expect(badge?.name).toBe("unknown-host");
  });

  it("shows the placement REASON in the tooltip", () => {
    const badge = describeHostBadge(
      {
        resolvedHostId: "mac-mini",
        placementReason: "least loaded: mac-mini at 1.20 load on 12 cores (0.10 per core)",
      },
      HOSTS,
    );
    expect(badge?.title).toBe("least loaded: mac-mini at 1.20 load on 12 cores (0.10 per core)");
  });

  it("replaces the host ID in the reason with the name the badge shows", () => {
    // The decision names the host by its id — and a remote host's id is a
    // UUID. The operator knows "studio-mac"; a tooltip full of UUIDs is
    // not an answer.
    const badge = describeHostBadge(
      {
        resolvedHostId: "3f2a9c1e-0000-4000-8000-000000000000",
        placementReason:
          "least loaded: 3f2a9c1e-0000-4000-8000-000000000000 at 1.20 load on 12 cores",
      },
      HOSTS,
    );
    expect(badge?.title).toBe("least loaded: studio-mac at 1.20 load on 12 cores");
    expect(badge?.title).not.toContain("3f2a9c1e");
  });

  it("falls back to 'Runs on host: X' when the session has no recorded reason", () => {
    const badge = describeHostBadge({ resolvedHostId: "mac-mini", placementReason: null }, HOSTS);
    expect(badge?.title).toBe("Runs on host: mac-mini");
  });

  it("shows a PINNED session's reason — the pinned path records one too", () => {
    const badge = describeHostBadge(
      { resolvedHostId: "mac-mini", placementReason: "pinned to the project's host mac-mini" },
      HOSTS,
    );
    expect(badge?.title).toBe("pinned to the project's host mac-mini");
  });
});
