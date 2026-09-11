import { describe, it, expect } from "vitest";
import {
  dockerSessionIdentity,
  dockRowKey,
  runningSessionFor,
  composeProjectForControl,
  groupDockerControls,
  holdVanishedDockerControls,
  dockLogPaneComfortHeightPx,
  dockMonitorFullMinHeightPx,
  dockMonitorMinHeightPx,
  dockMonitorMinWidthPx,
  imagePillLabel,
  imageTag,
} from "./dockHelpers.js";
import { makeSession } from "../test/fixtures.js";
import type { DockControl } from "../api/index.js";

function dockerControl(overrides: Partial<DockControl> = {}): DockControl {
  return {
    id: "docker:sanctuary:web",
    title: "web",
    command: "docker compose -p sanctuary logs -f --tail=200 web",
    source: "docker",
    docker: {
      composeProject: "sanctuary",
      service: "web",
      containerName: "sanctuary-web",
      state: "running",
      status: "Up 2 hours",
      imageRef: "ghcr.io/s3ntin3l8/sanctuary:edge",
      imageId: "sha256:current",
      buildOnly: false,
    },
    ...overrides,
  };
}

function configControl(overrides: Partial<DockControl> = {}): DockControl {
  return { id: "dev", title: "Dev server", command: "npm run dev", ...overrides };
}

describe("imageTag", () => {
  it("shortens a name@sha256:... digest reference", () => {
    expect(imageTag("ghcr.io/s3ntin3l8/sanctuary@sha256:" + "b2".repeat(32))).toBe(
      "sha256:b2b2b2b2b2b2",
    );
  });

  it("shortens a BARE sha256:<64 hex> ref with no name/tag at all (issue #1221)", () => {
    expect(imageTag("sha256:" + "c3".repeat(32))).toBe("sha256:c3c3c3c3c3c3");
  });

  it("still returns the ordinary tag for a normal name:tag ref", () => {
    expect(imageTag("ghcr.io/s3ntin3l8/sanctuary:edge")).toBe("edge");
  });

  it("returns latest for a ref with no explicit tag", () => {
    expect(imageTag("nginx")).toBe("latest");
  });
});

// Issue #1221 — a build-only service whose old, default-named image has
// been pruned reports a bare sha256: digest; imagePillLabel shows compose's
// own default build-image name instead, since that's a far more legible
// (and still correct) label than any digest shortening alone would give.
describe("imagePillLabel", () => {
  it("shows compose's default build-image name for a build-only service with a bare digest imageRef", () => {
    expect(
      imagePillLabel({
        composeProject: "pocket-portfolio-tracker",
        service: "api",
        buildOnly: true,
        imageRef: "sha256:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
      }),
    ).toBe("pocket-portfolio-tracker-api");
  });

  it("falls through to imageTag for a build-only service that still has a real tag", () => {
    expect(
      imagePillLabel({
        composeProject: "pocket-portfolio-tracker",
        service: "api",
        buildOnly: true,
        imageRef: "pocket-portfolio-tracker-api:latest",
      }),
    ).toBe("latest");
  });

  it("falls through to imageTag for a registry-image (non-build-only) service with a bare digest — still shortened", () => {
    // Hermes review — imageTag() itself now shortens a bare `sha256:` ref
    // the same way it already shortened the `name@sha256:...` form, so a
    // non-build-only service (a pruned local copy of a registry image,
    // say) also gets a legible pill instead of the raw 64-char hash.
    expect(
      imagePillLabel({
        composeProject: "sanctuary",
        service: "db",
        buildOnly: false,
        imageRef: "sha256:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
      }),
    ).toBe("sha256:a1a1a1a1a1a1");
  });

  it("uses the ordinary tag for a build-only service with a normal registry-style imageRef", () => {
    expect(
      imagePillLabel({
        composeProject: "sanctuary",
        service: "web",
        buildOnly: true,
        imageRef: "ghcr.io/s3ntin3l8/sanctuary:edge",
      }),
    ).toBe("edge");
  });
});

describe("dockerSessionIdentity", () => {
  it("is docker-logs:<containerName> for a docker-sourced control", () => {
    expect(dockerSessionIdentity(dockerControl())).toBe("docker-logs:sanctuary-web");
  });

  it("is null for a non-docker (dock.json) control", () => {
    expect(dockerSessionIdentity(configControl())).toBeNull();
  });
});

describe("dockRowKey", () => {
  it("is dockerSessionIdentity's own value for a docker-sourced control", () => {
    expect(dockRowKey(dockerControl())).toBe("docker-logs:sanctuary-web");
  });

  it("namespaces a plain (dock.json) control's id under dock-config:", () => {
    expect(dockRowKey(configControl())).toBe("dock-config:dev");
  });

  it("never collides with a real docker control even when a dock.json control's id is crafted to match its dockerSessionIdentity string verbatim (docs/dock.md's documented override escape hatch)", () => {
    const real = dockerControl();
    const collidingConfig = configControl({ id: dockerSessionIdentity(real) as string });
    expect(dockRowKey(collidingConfig)).not.toBe(dockRowKey(real));
  });
});

describe("runningSessionFor", () => {
  it("matches a docker control by its stable identity even when the command text differs", () => {
    // The exact bug this fixes: discovery reconstructs `command` fresh from
    // live container labels on every poll (docker-service-detect.ts's
    // composeContextFlags) — it can change text (a different config-file
    // resolution, a fallback path kicking in) without the underlying
    // service having changed, which would silently orphan a running log
    // session if matched by command string alone.
    const control = dockerControl({
      command: "docker compose -p sanctuary -f new.yml logs -f web",
    });
    const session = makeSession({
      kind: "dock",
      name: "docker-logs:sanctuary-web",
      command: "docker compose -p sanctuary logs -f --tail=200 web", // stale/old text
    });
    expect(runningSessionFor(control, [session])).toBe(session);
  });

  it("falls back to command-string matching for a non-docker control", () => {
    const control = configControl();
    const session = makeSession({ kind: "dock", command: "npm run dev" });
    expect(runningSessionFor(control, [session])).toBe(session);
  });

  it("falls back to command-string matching for a docker control with no name-matched session", () => {
    const control = dockerControl();
    const session = makeSession({ kind: "dock", command: control.command });
    expect(runningSessionFor(control, [session])).toBe(session);
  });

  it("returns undefined when nothing matches by identity or command", () => {
    const control = dockerControl();
    const session = makeSession({ kind: "dock", command: "something else entirely" });
    expect(runningSessionFor(control, [session])).toBeUndefined();
  });
});

function ephemeralControl(actionId: string, composeProject: string): DockControl {
  return {
    id: `${actionId}:${composeProject}`,
    title: `${actionId} ${composeProject}`,
    command: "docker compose ... ",
    source: "docker",
  };
}

describe("composeProjectForControl", () => {
  it("reads composeProject straight off a docker-bearing control", () => {
    expect(composeProjectForControl(dockerControl())).toBe("sanctuary");
  });

  it.each(["docker-update", "docker-restart", "docker-apply", "docker-rebuild", "docker-stop"])(
    "parses the %s: ephemeral id prefix",
    (actionId) => {
      expect(composeProjectForControl(ephemeralControl(actionId, "sanctuary"))).toBe("sanctuary");
    },
  );

  it("returns null for an unrecognized ephemeral id prefix", () => {
    expect(composeProjectForControl(ephemeralControl("docker-something-else", "sanctuary"))).toBe(
      null,
    );
  });

  it("returns null for a plain dock.json control", () => {
    expect(composeProjectForControl(configControl())).toBeNull();
  });

  it("issue #1112 — prefers the real composeProject field over parsing the id", () => {
    // A control reconstructed from a live `docker-stack:<composeProject>`
    // session (Dock.tsx, dock log-streaming resize fix symptom 3) has no
    // actionId to parse an id like `<actionId>:<composeProject>` from in
    // the first place — it must resolve via this field alone.
    const control: DockControl = {
      id: "docker-stack:sanctuary",
      title: "Stack action running — sanctuary",
      command: "docker compose ... ",
      source: "docker",
      composeProject: "sanctuary",
    };
    expect(composeProjectForControl(control)).toBe("sanctuary");
  });

  it("issue #1112 — composeProject wins even when the id would otherwise parse to something else", () => {
    const control: DockControl = {
      ...ephemeralControl("docker-restart", "wrong-project"),
      composeProject: "sanctuary",
    };
    expect(composeProjectForControl(control)).toBe("sanctuary");
  });
});

describe("groupDockerControls", () => {
  it("groups two compose projects into two groups, sorted by project name", () => {
    const web = dockerControl({
      id: "docker:sanctuary:web",
      docker: { ...dockerControl().docker!, composeProject: "sanctuary", service: "web" },
    });
    const api = dockerControl({
      id: "docker:pocket-dev:api",
      docker: { ...dockerControl().docker!, composeProject: "pocket-dev", service: "api" },
    });
    const { groups, ungrouped } = groupDockerControls([web, api]);

    expect(groups.map((g) => g.composeProject)).toEqual(["pocket-dev", "sanctuary"]);
    expect(ungrouped).toEqual([]);
  });

  it("places an ephemeral action's control inside its own compose project's group", () => {
    const web = dockerControl();
    const ephemeral = ephemeralControl("docker-restart", "sanctuary");
    const { groups } = groupDockerControls([ephemeral, web]);

    expect(groups).toHaveLength(1);
    expect(groups[0].controls).toEqual([ephemeral, web]);
  });

  it("sends an unparseable control to `ungrouped` rather than dropping it", () => {
    const stray = configControl({ id: "dev" });
    const { groups, ungrouped } = groupDockerControls([stray]);

    expect(groups).toEqual([]);
    expect(ungrouped).toEqual([stray]);
  });

  it("gives an ephemeral-only group (no docker-bearing control yet) all-null representatives", () => {
    const { groups } = groupDockerControls([ephemeralControl("docker-restart", "sanctuary")]);

    expect(groups[0].anyRep).toBeNull();
    expect(groups[0].pullRep).toBeNull();
    expect(groups[0].rebuildRep).toBeNull();
  });

  describe("representative selection", () => {
    it("an all-registry-image stack gets pullRep only", () => {
      const { groups } = groupDockerControls([
        dockerControl({ docker: { ...dockerControl().docker!, buildOnly: false } }),
      ]);
      expect(groups[0].pullRep).not.toBeNull();
      expect(groups[0].rebuildRep).toBeNull();
    });

    it("an all-build-only stack gets rebuildRep only", () => {
      const { groups } = groupDockerControls([
        dockerControl({ docker: { ...dockerControl().docker!, buildOnly: true } }),
      ]);
      expect(groups[0].pullRep).toBeNull();
      expect(groups[0].rebuildRep).not.toBeNull();
    });

    it("a mixed stack gets BOTH pullRep and rebuildRep, from the correct services", () => {
      const registryService = dockerControl({
        id: "docker:mixed:web",
        docker: { ...dockerControl().docker!, service: "web", buildOnly: false },
      });
      const buildOnlyService = dockerControl({
        id: "docker:mixed:api",
        docker: { ...dockerControl().docker!, service: "api", buildOnly: true },
      });
      const { groups } = groupDockerControls([registryService, buildOnlyService]);

      expect(groups[0].pullRep?.docker?.buildOnly).toBe(false);
      expect(groups[0].rebuildRep?.docker?.buildOnly).toBe(true);
    });

    it("prefers a running service over a stopped one", () => {
      const stopped = dockerControl({
        id: "docker:sanctuary:api",
        docker: { ...dockerControl().docker!, service: "api", state: "exited" },
      });
      const running = dockerControl({
        id: "docker:sanctuary:web",
        docker: { ...dockerControl().docker!, service: "web", state: "running" },
      });
      const { groups } = groupDockerControls([stopped, running]);

      expect(groups[0].anyRep).toBe(running);
    });

    it("is deterministic regardless of input order", () => {
      const a = dockerControl({
        id: "docker:sanctuary:api",
        docker: { ...dockerControl().docker!, service: "api" },
      });
      const b = dockerControl({
        id: "docker:sanctuary:web",
        docker: { ...dockerControl().docker!, service: "web" },
      });
      expect(groupDockerControls([a, b]).groups[0].anyRep).toBe(
        groupDockerControls([b, a]).groups[0].anyRep,
      );
    });
  });
});

describe("holdVanishedDockerControls", () => {
  const GRACE_MS = 30_000;

  it("holds a docker control that vanished within the grace window, re-inserted at its previous index", () => {
    const web = dockerControl({
      id: "docker:sanctuary:web",
      docker: { ...dockerControl().docker!, service: "web" },
    });
    const api = dockerControl({
      id: "docker:sanctuary:api",
      docker: { ...dockerControl().docker!, service: "api" },
    });

    // api vanishes (a compose recreate deleted its container) while web stays.
    const { controls, heldIds, vanishedAt } = holdVanishedDockerControls(
      [api, web],
      [web],
      new Map(),
      1_000,
      GRACE_MS,
    );

    expect(heldIds.has(api.id)).toBe(true);
    // Re-inserted at its previous index (0), not appended at the end.
    expect(controls).toEqual([api, web]);
    expect(vanishedAt.get(api.id)).toBe(1_000);
  });

  it("is pure — never mutates the `vanishedAt` map it's given", () => {
    const api = dockerControl({ id: "docker:sanctuary:api" });
    const original = new Map<string, number>();

    holdVanishedDockerControls([api, api], [], original, 1_000, GRACE_MS);

    // Safe under React StrictMode's double-invoked render body (Dock.tsx
    // calls this from render, not an effect — see the function's own doc
    // comment): a second call with the SAME `original` map must see the
    // exact same input every time, not whatever a prior call already wrote
    // into it.
    expect(original.size).toBe(0);
  });

  it("drops a control once it has been missing for graceMs or more", () => {
    const api = dockerControl({ id: "docker:sanctuary:api" });

    const { controls, heldIds, vanishedAt } = holdVanishedDockerControls(
      [api],
      [],
      new Map([[api.id, 1_000]]),
      1_000 + GRACE_MS,
      GRACE_MS,
    );

    expect(heldIds.size).toBe(0);
    expect(controls).toEqual([]);
    expect(vanishedAt.has(api.id)).toBe(false);
  });

  it("clears the vanished-at entry once the control re-appears", () => {
    const api = dockerControl({ id: "docker:sanctuary:api" });

    const { controls, heldIds, vanishedAt } = holdVanishedDockerControls(
      [api],
      [api],
      new Map([[api.id, 1_000]]),
      1_010,
      GRACE_MS,
    );

    expect(heldIds.size).toBe(0);
    expect(controls).toEqual([api]);
    expect(vanishedAt.has(api.id)).toBe(false);
  });

  it("never holds a dock.json (non-docker) control — its presence is config, not container state", () => {
    const dev = configControl();

    const { controls, heldIds, vanishedAt } = holdVanishedDockerControls(
      [dev],
      [],
      new Map(),
      1_000,
      GRACE_MS,
    );

    expect(heldIds.size).toBe(0);
    expect(controls).toEqual([]);
    expect(vanishedAt.size).toBe(0);
  });
});

describe("groupDockerControls with heldIds", () => {
  it("keeps a held control in the group's `controls` for rendering/sizing but excludes it from representative selection", () => {
    const web = dockerControl({ id: "docker:sanctuary:web" });
    const held = dockerControl({
      id: "docker:sanctuary:api",
      docker: { ...dockerControl().docker!, service: "api", state: "running" },
    });
    const { groups } = groupDockerControls([web, held], new Set([held.id]));

    expect(groups).toHaveLength(1);
    expect(groups[0].controls).toEqual([web, held]);
    // Only `web` was ever a candidate — not whatever selectRepresentatives
    // would have picked from a list that includes the held control's stale
    // "running" state.
    expect(groups[0].anyRep?.id).toBe(web.id);
  });

  it("nulls anyRep/pullRep/rebuildRep when every docker-bearing control in the group is held", () => {
    const held = dockerControl({ id: "docker:sanctuary:web" });
    const { groups } = groupDockerControls([held], new Set([held.id]));

    expect(groups[0].anyRep).toBeNull();
    expect(groups[0].pullRep).toBeNull();
    expect(groups[0].rebuildRep).toBeNull();
    // The held control is still present for rendering/sizing purposes.
    expect(groups[0].controls).toEqual([held]);
  });
});

describe("dockMonitorMinWidthPx", () => {
  it("matches the CSS comment's own worked derivation at the default 14px/4px", () => {
    // 40 * 8.4 + 14 (addon-fit reserve) + 4*2 (padding) + 2 (border) + 4
    // (cross-platform margin) = 364 — the same static number
    // .dock-monitor's own CSS min-width falls back to.
    expect(dockMonitorMinWidthPx(14, 4)).toBe(364);
  });

  it("scales up at a larger configured font size — this is the whole point of the fix", () => {
    // Hermes review round 2 — the static 364px only holds at the default
    // font size; a user on a larger one needs a proportionally wider floor
    // to actually clear MIN_TERMINAL_COLS (40) rather than silently
    // reverting to the permanent-shrink regime this exists to fix.
    const at14 = dockMonitorMinWidthPx(14, 4);
    const at20 = dockMonitorMinWidthPx(20, 4);
    expect(at20).toBeGreaterThan(at14);
  });

  it("scales up with a larger configured padding too", () => {
    const at4 = dockMonitorMinWidthPx(14, 4);
    const at16 = dockMonitorMinWidthPx(14, 16);
    expect(at16).toBe(at4 + (16 - 4) * 2);
  });
});

describe("dockMonitorMinHeightPx", () => {
  it("matches the worked derivation at the default 14px/4px", () => {
    // 10 (MIN_TERMINAL_ROWS) * 18.9 (measured cell height at 14px, scaled
    // onto dockMonitorMinWidthPx's own pinned 8.4px-cell-width baseline —
    // see PX_PER_ROW_AT_14PX's own doc comment for why 18.9, not the raw
    // 18 a live measurement read) + 4*2 (padding) + 4 (cross-platform
    // margin) = 201. No addon-fit reserve — unlike the width derivation,
    // proposeDimensions() never subtracts one from the height measurement.
    expect(dockMonitorMinHeightPx(14, 4)).toBe(201);
  });

  it("scales up at a larger configured font size — this is the whole point of the fix", () => {
    // Confirmed live against a real dock monitor's own GeometryMessage
    // echo: {"cols":63,"rows":10,"minCols":40,"minRows":10} — rows floored
    // exactly at MIN_TERMINAL_ROWS, on a dock already taller than the
    // static default, because nothing derived a height floor at all before
    // this fix.
    const at14 = dockMonitorMinHeightPx(14, 4);
    const at20 = dockMonitorMinHeightPx(20, 4);
    expect(at20).toBeGreaterThan(at14);
  });

  it("scales up with a larger configured padding too", () => {
    const at4 = dockMonitorMinHeightPx(14, 4);
    const at16 = dockMonitorMinHeightPx(14, 16);
    expect(at16).toBe(at4 + (16 - 4) * 2);
  });
});

describe("dockMonitorFullMinHeightPx", () => {
  it("adds the header (28px) and border (2px) on top of dockMonitorMinHeightPx's body-only floor", () => {
    // 201 (dockMonitorMinHeightPx(14, 4)) + 28 (.dock-monitor-header's own
    // fixed CSS height) + 2 (.dock-monitor's own border) = 231. This is the
    // value that actually has to be applied to `.dock-monitor` itself —
    // review caught a real bug in an earlier version of this fix that
    // applied the body-only 201 to `.dock-monitor-body` instead, which
    // `.dock-monitor`'s own `overflow: hidden` silently defeated (see this
    // function's own doc comment, dockHelpers.ts).
    expect(dockMonitorFullMinHeightPx(14, 4)).toBe(231);
  });

  it("equals dockMonitorMinHeightPx plus a fixed 30px at every font size", () => {
    for (const fontSize of [10, 14, 16, 20]) {
      expect(dockMonitorFullMinHeightPx(fontSize, 4)).toBe(
        dockMonitorMinHeightPx(fontSize, 4) + 30,
      );
    }
  });
});

describe("dockLogPaneComfortHeightPx", () => {
  it("is 315 at the default 14px font / 4px padding — double the 10-row hard floor's row count, not the floor itself", () => {
    // 16 rows (COMFORT_LOG_ROWS) × 18.9 (PX_PER_ROW_AT_14PX) + 2×4 (padding)
    // + 4 (cross-platform margin) = 314.4, ceil'd to 315 — a genuinely
    // readable default, not merely a non-clipping one (dockMonitorMinHeightPx
    // is 201 at the same settings; this is deliberately larger, see this
    // function's own doc comment).
    expect(dockLogPaneComfortHeightPx(14, 4)).toBe(315);
  });

  it("scales with font size the same way dockMonitorMinHeightPx does — both share one cell-height derivation", () => {
    for (const fontSize of [10, 14, 16, 20]) {
      const comfort = dockLogPaneComfortHeightPx(fontSize, 4);
      const floor = dockMonitorMinHeightPx(fontSize, 4);
      // Both terminalContentHeightPx(rows, ...) calls only differ in row
      // count (16 vs. 10) — the ratio between the two should track that
      // 1.6x, not drift as font size changes.
      expect(comfort).toBeGreaterThan(floor);
    }
  });
});
