import { describe, it, expect } from "vitest";
import { HostHeartbeatTracker } from "../../src/services/host-heartbeat.js";

describe("HostHeartbeatTracker (issue #246)", () => {
  it("reports the local host as always online with no timestamp", () => {
    const tracker = new HostHeartbeatTracker();
    expect(tracker.getHealth("local")).toEqual({ status: "online", lastSeenAt: null });
  });

  it("reports pending for a host that has never been swept", () => {
    const tracker = new HostHeartbeatTracker();
    expect(tracker.getHealth("never-swept")).toEqual({ status: "pending", lastSeenAt: null });
  });

  it("goes online with a timestamp on a successful ping", () => {
    const tracker = new HostHeartbeatTracker();
    tracker.recordSuccess("h1");
    const health = tracker.getHealth("h1");
    expect(health.status).toBe("online");
    expect(health.lastSeenAt).toEqual(expect.any(Number));
  });

  it("degrades on the first two missed pings, then goes offline on the third", () => {
    const tracker = new HostHeartbeatTracker();
    tracker.recordFailure("h1");
    expect(tracker.getHealth("h1").status).toBe("degraded");
    tracker.recordFailure("h1");
    expect(tracker.getHealth("h1").status).toBe("degraded");
    tracker.recordFailure("h1");
    expect(tracker.getHealth("h1").status).toBe("offline");
  });

  it("recovers to online and resets the missed counter on a successful ping after failures", () => {
    const tracker = new HostHeartbeatTracker();
    tracker.recordFailure("h1");
    tracker.recordFailure("h1");
    tracker.recordSuccess("h1");
    expect(tracker.getHealth("h1").status).toBe("online");

    // Missed count reset by the prior success — a single failure right
    // after must not jump straight past "degraded" to "offline".
    tracker.recordFailure("h1");
    expect(tracker.getHealth("h1").status).toBe("degraded");
  });

  it("keeps the last-seen timestamp across failures until the next success", () => {
    const tracker = new HostHeartbeatTracker();
    tracker.recordSuccess("h1");
    const firstSeen = tracker.getHealth("h1").lastSeenAt;
    tracker.recordFailure("h1");
    expect(tracker.getHealth("h1").lastSeenAt).toBe(firstSeen);
  });

  it("tracks hosts independently", () => {
    const tracker = new HostHeartbeatTracker();
    tracker.recordSuccess("h1");
    tracker.recordFailure("h2");
    expect(tracker.getHealth("h1").status).toBe("online");
    expect(tracker.getHealth("h2").status).toBe("degraded");
  });

  it("clearForTests resets all tracked state", () => {
    const tracker = new HostHeartbeatTracker();
    tracker.recordSuccess("h1");
    tracker.clearForTests();
    expect(tracker.getHealth("h1")).toEqual({ status: "pending", lastSeenAt: null });
  });
});
