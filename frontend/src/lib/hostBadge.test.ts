import { describe, it, expect } from "vitest";
import {
  describeHostBadge,
  describeTaskHost,
  hasRemoteHosts,
  projectHostCount,
  projectSpansHosts,
} from "./hostBadge.js";
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
      describeHostBadge(
        { resolvedHostId: "local", placementReason: "pinned to local" },
        () => HOSTS,
      ),
    ).toBeNull();
  });

  it("does NOT read the fleet list for a LOCAL session", () => {
    // The getter is lazy on purpose: a local session has no badge, so
    // reading the fleet's host list for it is work for nothing — and a
    // store mock without a getState() would throw on the way.
    let reads = 0;
    const badge = describeHostBadge({ resolvedHostId: "local", placementReason: null }, () => {
      reads += 1;
      return HOSTS;
    });
    expect(badge).toBeNull();
    expect(reads).toBe(0);
  });

  it("names the host, by its DISPLAY name", () => {
    const badge = describeHostBadge(
      { resolvedHostId: "3f2a9c1e-0000-4000-8000-000000000000", placementReason: null },
      () => HOSTS,
    );
    expect(badge?.name).toBe("studio-mac");
  });

  it("falls back to the host id when the fleet list has no name for it", () => {
    const badge = describeHostBadge(
      { resolvedHostId: "unknown-host", placementReason: null },
      () => HOSTS,
    );
    expect(badge?.name).toBe("unknown-host");
  });

  it("shows the placement REASON in the tooltip", () => {
    const badge = describeHostBadge(
      {
        resolvedHostId: "mac-mini",
        placementReason: "least loaded: mac-mini at 1.20 load on 12 cores (0.10 per core)",
      },
      () => HOSTS,
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
      () => HOSTS,
    );
    expect(badge?.title).toBe("least loaded: studio-mac at 1.20 load on 12 cores");
    expect(badge?.title).not.toContain("3f2a9c1e");
  });

  it("falls back to 'Runs on host: X' when the session has no recorded reason", () => {
    const badge = describeHostBadge(
      { resolvedHostId: "mac-mini", placementReason: null },
      () => HOSTS,
    );
    expect(badge?.title).toBe("Runs on host: mac-mini");
  });

  it("shows a PINNED session's reason — the pinned path records one too", () => {
    const badge = describeHostBadge(
      { resolvedHostId: "mac-mini", placementReason: "pinned to the project's host mac-mini" },
      () => HOSTS,
    );
    expect(badge?.title).toBe("pinned to the project's host mac-mini");
  });
});

describe("hasRemoteHosts / describeTaskHost (#2236)", () => {
  const local = makeHost({ id: "local", name: "local" });
  const mini = makeHost({ id: "mac-mini", name: "Mac mini" });

  it("hasRemoteHosts is false for only the local host", () => {
    expect(hasRemoteHosts([])).toBe(false);
    expect(hasRemoteHosts([local])).toBe(false);
    expect(hasRemoteHosts([local, mini])).toBe(true);
  });

  it("is null on a local-only install, whatever the task says", () => {
    expect(
      describeTaskHost({ placementRequirement: '{"platform":"darwin"}' }, null, "x", [local]),
    ).toBeNull();
  });

  it("prefers the worker session's host", () => {
    const chip = describeTaskHost(
      { placementRequirement: '{"platform":"darwin"}' },
      { resolvedHostId: "mac-mini", placementReason: null },
      "local",
      [local, mini],
    );
    expect(chip?.label).toBe("on Mac mini");
  });

  it("says 'on this machine' for a worker session on the local host", () => {
    expect(
      describeTaskHost(
        { placementRequirement: null },
        { resolvedHostId: "local", placementReason: null },
        "local",
        [local, mini],
      )?.label,
    ).toBe("on this machine");
  });

  it("describes a combined requirement, falling back to the raw host id", () => {
    const chip = describeTaskHost(
      { placementRequirement: '{"hostId":"gone","platform":"linux"}' },
      null,
      "local",
      [local, mini],
    );
    expect(chip?.label).toBe("needs linux · gone");
  });

  it("ignores a corrupt or empty requirement", () => {
    for (const raw of ["{nope", "[]", '"x"', "{}", "null"]) {
      expect(
        describeTaskHost({ placementRequirement: raw }, null, "local", [local, mini])?.label,
      ).toBe("auto");
    }
  });

  it("pins to a remote project host, else auto", () => {
    expect(
      describeTaskHost({ placementRequirement: null }, null, "mac-mini", [local, mini])?.label,
    ).toBe("pinned · Mac mini");
    expect(
      describeTaskHost({ placementRequirement: null }, null, undefined, [local, mini])?.label,
    ).toBe("auto");
  });
});

// Issue #2238 — once a project spans hosts, a local session gets a badge too.
describe("describeHostBadge spansHosts (issue #2238)", () => {
  it("labels a LOCAL session 'this machine' when the project spans hosts", () => {
    const badge = describeHostBadge(
      { resolvedHostId: "local", placementReason: null },
      () => HOSTS,
      { spansHosts: true },
    );
    expect(badge).toEqual({ name: "this machine", title: "Runs on host: this machine" });
  });

  it("uses the placement reason as the local tooltip", () => {
    const badge = describeHostBadge(
      { resolvedHostId: "local", placementReason: "pinned to local" },
      () => HOSTS,
      { spansHosts: true },
    );
    expect(badge?.title).toBe("pinned to local");
  });

  it("still never reads the fleet list for a local session", () => {
    let reads = 0;
    describeHostBadge(
      { resolvedHostId: "local", placementReason: null },
      () => {
        reads += 1;
        return HOSTS;
      },
      { spansHosts: true },
    );
    expect(reads).toBe(0);
  });

  it("keeps a local session unbadged when spansHosts is false or unset", () => {
    const s = { resolvedHostId: "local", placementReason: null };
    expect(describeHostBadge(s, () => HOSTS, { spansHosts: false })).toBeNull();
    expect(describeHostBadge(s, () => HOSTS)).toBeNull();
  });

  it("is nothing for a session with no resolved host", () => {
    expect(describeHostBadge(null, () => HOSTS, { spansHosts: true })).toBeNull();
  });
});

describe("projectSpansHosts / projectHostCount (issue #2238)", () => {
  const sess = (resolvedHostId: string, status = "active", projectId = 1) => ({
    projectId,
    status,
    resolvedHostId,
  });
  const P = { id: 1, hostId: "local", hostCwds: {} as Record<string, string> };

  it("is false for a single-host project", () => {
    expect(projectSpansHosts(P, [sess("local"), sess("local")])).toBe(false);
    expect(projectSpansHosts(P, [])).toBe(false);
    expect(projectSpansHosts(undefined, [])).toBe(false);
    expect(projectHostCount(P, [sess("local")])).toBe(1);
  });

  it("is true once hostCwds names another host, even with no sessions", () => {
    const p = { id: 1, hostId: "local", hostCwds: { "mac-mini": "/x" } };
    expect(projectSpansHosts(p, [])).toBe(true);
    expect(projectHostCount(p, [sess("local")])).toBe(2);
  });

  it("is false when hostCwds names only the local host", () => {
    expect(projectSpansHosts({ id: 1, hostId: "local", hostCwds: { local: "/x" } }, [])).toBe(
      false,
    );
  });

  it("counts a remote-hosted project as one host, not two", () => {
    const p = { id: 1, hostId: "mac-mini", hostCwds: {} };
    expect(projectHostCount(p, [sess("mac-mini")])).toBe(1);
    expect(projectSpansHosts(p, [sess("mac-mini")])).toBe(false);
    expect(projectSpansHosts(p, [sess("mac-mini"), sess("local")])).toBe(true);
  });

  it("is true when the project's sessions resolve to more than one host", () => {
    expect(projectSpansHosts(P, [sess("local"), sess("mac-mini")])).toBe(true);
    expect(projectHostCount(P, [sess("local"), sess("mac-mini")])).toBe(2);
  });

  it("ignores killed sessions and other projects' sessions", () => {
    expect(projectSpansHosts(P, [sess("local"), sess("mac-mini", "killed")])).toBe(false);
    expect(projectSpansHosts(P, [sess("local"), sess("mac-mini", "active", 2)])).toBe(false);
  });
});
