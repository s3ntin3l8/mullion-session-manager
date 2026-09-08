import { describe, it, expect } from "vitest";
import {
  dockerSessionIdentity,
  runningSessionFor,
  composeProjectForControl,
  groupDockerControls,
  holdVanishedDockerControls,
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

describe("dockerSessionIdentity", () => {
  it("is docker-logs:<containerName> for a docker-sourced control", () => {
    expect(dockerSessionIdentity(dockerControl())).toBe("docker-logs:sanctuary-web");
  });

  it("is null for a non-docker (dock.json) control", () => {
    expect(dockerSessionIdentity(configControl())).toBeNull();
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
