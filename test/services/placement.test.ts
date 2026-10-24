import { describe, it, expect } from "vitest";
import {
  chooseHost,
  type PlacementCandidate,
  type PlacementContext,
} from "../../src/services/placement.js";
import type { HostCapacity } from "../../src/services/host-capacity.js";
import { PLACEMENT_MODES } from "../../src/shared/constants.js";

// Issue #1723 / roadmap 8.9 — the placement policy's decision table.
//
// The policy is a PURE function over a supplied candidate set, so its whole
// table is testable here without a DB, a network, or a clock. These tests
// are the decision table; the assembler's own tests (test/services/
// placement-assembler.test.ts) cover what goes INTO the candidate set.

/** A capacity reading with the two numbers the policy compares. */
function capacity(
  loadAverage1m: number,
  logicalCores: number,
  overrides: Partial<HostCapacity> = {},
): HostCapacity {
  return {
    platform: "linux",
    logicalCores,
    loadAverage1m,
    memory: { totalBytes: 1000, freeBytes: 500 },
    sessions: { tracked: 0, alive: 0 },
    ...overrides,
  };
}

function candidate(overrides: Partial<PlacementCandidate> = {}): PlacementCandidate {
  return {
    hostId: "remote-a",
    isLocal: false,
    online: true,
    drained: false,
    capacity: capacity(1, 8),
    ...overrides,
  };
}

function context(overrides: Partial<PlacementContext> = {}): PlacementContext {
  return {
    pinnedHostId: "local",
    unattended: true,
    localCapacity: capacity(0.5, 8),
    ...overrides,
  };
}

const localCandidate = (overrides: Partial<PlacementCandidate> = {}) =>
  candidate({ hostId: "local", isLocal: true, capacity: null, ...overrides });

describe("the shared placement modes stay in step (issue #1723)", () => {
  it("lists exactly the modes the shared type allows", () => {
    // PlacementMode is DERIVED from PLACEMENT_MODES — `(typeof
    // PLACEMENT_MODES)[number]`, the TaskStatus/TASK_STATUSES precedent in
    // src/shared/constants.ts. The list and the type are therefore ONE
    // declaration, not two that have to be kept in step: there is no second
    // spelling to drift. The derivation lives in src/**, which tsc covers,
    // so it is the type gate that holds the pair together.
    //
    // (An earlier draft kept the type in src/shared/types.ts and guarded the
    // pair with Exclude<> assertions HERE — in test/, which nothing
    // typechecks: the tsconfig covers src/** only and vitest transpiles
    // without typechecking. Those assertions could not have bitten.)
    //
    // What this test still earns: the list's CONTENTS are pinned, so adding
    // a mode is a deliberate act with the policy updated to match, not a
    // stray edit that silently widens what the routes accept.
    expect([...PLACEMENT_MODES]).toEqual(["pinned", "auto"]);
  });
});

describe("chooseHost — the placement decision table (issue #1723)", () => {
  it("falls back to the project's host when NO host is eligible", () => {
    const decision = chooseHost(
      [
        candidate({ hostId: "remote-offline", online: false }),
        candidate({ hostId: "remote-no-capacity", capacity: null }),
        candidate({ hostId: "remote-drained", drained: true }),
      ],
      context(),
    );
    expect(decision.hostId).toBe("local");
    expect(decision.fellBack).toBe(true);
    expect(decision.reason).toMatch(/no eligible host/);
    expect(decision.reason).toContain("local");
    expect(decision.considered).toEqual([]);
  });

  it("never fails: an empty candidate set still returns the pinned host", () => {
    const decision = chooseHost([], context({ pinnedHostId: "remote-a" }));
    expect(decision.hostId).toBe("remote-a");
    expect(decision.fellBack).toBe(true);
  });

  it("places an UNATTENDED session on the least loaded eligible host", () => {
    const decision = chooseHost(
      [
        candidate({ hostId: "remote-busy", capacity: capacity(6, 8) }),
        candidate({ hostId: "remote-idle", capacity: capacity(1, 8) }),
      ],
      context({ unattended: true }),
    );
    expect(decision.hostId).toBe("remote-idle");
    expect(decision.fellBack).toBe(false);
    expect(decision.reason).toContain("remote-idle");
    expect(decision.reason).toMatch(/least loaded/);
  });

  it("gives an unattended session NO local bonus — a busier remote wins", () => {
    // The point of the phase: drain the primary onto the idle machine.
    const decision = chooseHost(
      [localCandidate(), candidate({ hostId: "remote-idle", capacity: capacity(1, 8) })],
      context({ unattended: true, localCapacity: capacity(7, 8) }),
    );
    expect(decision.hostId).toBe("remote-idle");
  });

  it("prefers the LOCAL host for an INTERACTIVE session", () => {
    const decision = chooseHost(
      [localCandidate(), candidate({ hostId: "remote-idle", capacity: capacity(1, 8) })],
      context({ unattended: false, localCapacity: capacity(7, 8) }),
    );
    expect(decision.hostId).toBe("local");
    expect(decision.reason).toMatch(/interactive/);
    expect(decision.reason).toContain("local");
  });

  it("spills an interactive session to a remote only when local is NOT eligible", () => {
    const decision = chooseHost(
      [
        localCandidate({ online: false }),
        candidate({ hostId: "remote-idle", capacity: capacity(1, 8) }),
      ],
      context({ unattended: false }),
    );
    expect(decision.hostId).toBe("remote-idle");
    expect(decision.fellBack).toBe(false);
  });

  it("does not offer a host that never reported a capacity", () => {
    const decision = chooseHost(
      [candidate({ hostId: "remote-silent", capacity: null })],
      context({ unattended: false }),
    );
    // The local host is eligible (its capacity is in the context), so the
    // decision is local — the capacity-less remote was never considered.
    expect(decision.hostId).toBe("local");
    expect(decision.considered.map((c) => c.hostId)).not.toContain("remote-silent");
  });

  it("does not offer a degraded, offline or pending host", () => {
    // "online" is the only eligible verdict: a degraded host has already
    // missed a ping, an offline one has failed three, a pending one has
    // never answered.
    for (const online of [false]) {
      const decision = chooseHost(
        [candidate({ hostId: "remote-x", online })],
        context({ unattended: false }),
      );
      expect(decision.considered.map((c) => c.hostId)).not.toContain("remote-x");
    }
  });

  it("does not offer a drained host", () => {
    const decision = chooseHost(
      [candidate({ hostId: "remote-drained", drained: true })],
      context({ unattended: false }),
    );
    expect(decision.considered.map((c) => c.hostId)).not.toContain("remote-drained");
  });

  it("compares load PER CORE, not raw load", () => {
    // Load 4 on a 16-core box is a quarter of its capacity; load 4 on a
    // 4-core box is all of it. The wider machine is the idler one.
    const decision = chooseHost(
      [
        candidate({ hostId: "wide", capacity: capacity(4, 16) }),
        candidate({ hostId: "narrow", capacity: capacity(4, 4) }),
      ],
      context({ unattended: true }),
    );
    expect(decision.hostId).toBe("wide");
    expect(decision.considered.find((c) => c.hostId === "wide")?.loadPerCore).toBeCloseTo(0.25);
  });

  it("breaks a tie deterministically — the local host first, then the host id", () => {
    const localWins = chooseHost(
      [candidate({ hostId: "remote-a", capacity: capacity(2, 8) }), localCandidate()],
      context({ unattended: true, localCapacity: capacity(2, 8) }),
    );
    expect(localWins.hostId).toBe("local");

    const lexicographic = chooseHost(
      [
        candidate({ hostId: "remote-b", capacity: capacity(2, 8) }),
        candidate({ hostId: "remote-a", capacity: capacity(2, 8) }),
      ],
      context({ unattended: true }),
    );
    expect(lexicographic.hostId).toBe("remote-a");
  });

  it("marks the chosen host in the considered table, with both numbers", () => {
    const decision = chooseHost(
      [
        candidate({ hostId: "remote-busy", capacity: capacity(6, 8) }),
        candidate({ hostId: "remote-idle", capacity: capacity(1, 8) }),
      ],
      context({ unattended: true }),
    );
    const chosen = decision.considered.filter((c) => c.chosen);
    expect(chosen).toHaveLength(1);
    expect(chosen[0].hostId).toBe("remote-idle");
    expect(chosen[0].loadAverage1m).toBe(1);
    expect(chosen[0].logicalCores).toBe(8);
    expect(chosen[0].loadPerCore).toBeCloseTo(0.125);
  });

  it("uses the LOCAL host's live capacity from the context, not a stale candidate reading", () => {
    // The local host is measured on demand (issue #1721), so the context
    // carries its reading; a candidate's stale copy must not win.
    const decision = chooseHost(
      [localCandidate({ capacity: capacity(9, 8) })],
      context({ unattended: true, localCapacity: capacity(0.1, 8) }),
    );
    expect(decision.hostId).toBe("local");
    expect(decision.considered[0].loadAverage1m).toBe(0.1);
  });

  it("always returns a host and always a reason", () => {
    const decisions = [
      chooseHost([], context()),
      chooseHost([candidate()], context({ unattended: false })),
      chooseHost([candidate()], context({ unattended: true })),
    ];
    for (const decision of decisions) {
      expect(decision.hostId).toBeTruthy();
      expect(decision.reason).toBeTruthy();
      expect(decision.reason).toContain(decision.hostId);
    }
  });

  it("gives an interactive session the local bonus only when the PROJECT is local", async () => {
    // "Local" is the warm place to run a session only when the checkout is
    // already here. For a project that lives on a remote host, the local
    // machine does not have its code, so the local bonus does not apply and
    // the session follows the same least-loaded rule as an unattended one.
    // The local host is BUSY here (7 load on 8 cores) and the remote is
    // idle (1 on 8), so which host wins says exactly one thing: whether
    // the local BONUS applied.
    const busyLocal = capacity(7, 8);
    const candidates = [
      localCandidate(),
      candidate({ hostId: "remote-idle", capacity: capacity(1, 8) }),
    ];

    // The project is local: the bonus keeps the interactive session here,
    // even though the remote is the idler one.
    const localPreferred = chooseHost(
      candidates,
      context({ unattended: false, pinnedHostId: "local", localCapacity: busyLocal }),
    );
    expect(localPreferred.hostId).toBe("local");

    // The project lives on a remote host: "local" is not where its code
    // is, so there is no bonus, and the idle remote wins by load.
    const remoteHostedProject = chooseHost(
      candidates,
      context({ unattended: false, pinnedHostId: "remote-pinned", localCapacity: busyLocal }),
    );
    expect(remoteHostedProject.hostId).toBe("remote-idle");

    // ...and the case the rationale implies CANNOT happen: for a
    // remote-pinned project, the local host is still a candidate, so if it
    // is genuinely the idlest one it wins on load (no bonus, but no
    // penalty either). #1724 needs a fixed answer for this.
    const localIsIdlest = chooseHost(
      [localCandidate(), candidate({ hostId: "remote-busy", capacity: capacity(7, 8) })],
      context({
        unattended: false,
        pinnedHostId: "remote-pinned",
        localCapacity: capacity(1, 8),
      }),
    );
    expect(localIsIdlest.hostId).toBe("local");
  });

  it("never throws, whatever it is handed", () => {
    const weird = [
      chooseHost([candidate({ capacity: null })], context({ localCapacity: null })),
      chooseHost([candidate({ capacity: capacity(0, 0) })], context({ localCapacity: null })),
    ];
    for (const decision of weird) {
      expect(decision.hostId).toBeTruthy();
    }
  });
});
