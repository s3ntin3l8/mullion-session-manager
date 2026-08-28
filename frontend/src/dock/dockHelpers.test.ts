import { describe, it, expect } from "vitest";
import { dockerSessionIdentity, runningSessionFor } from "./dockHelpers.js";
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
