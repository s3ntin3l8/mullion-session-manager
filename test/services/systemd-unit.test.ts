import { describe, it, expect } from "vitest";
import {
  resolveServiceUnitFromCgroup,
  resolveServiceUnit,
  DEFAULT_SERVICE_UNIT,
} from "../../src/services/systemd-unit.js";

describe("resolveServiceUnitFromCgroup", () => {
  it("parses the leaf unit from a real systemd --user cgroup v2 path", () => {
    const cgroup = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/mullion.service\n";
    // Must resolve the leaf (mullion.service), NOT the user@1000.service
    // ancestor that also matches ".service" earlier in the same path —
    // restarting that ancestor unit would be a real foot-gun.
    expect(resolveServiceUnitFromCgroup(cgroup)).toBe("mullion.service");
  });

  it("resolves a pre-rename host's claude-remote-session.service unchanged", () => {
    const cgroup =
      "0::/user.slice/user-1000.slice/user@1000.service/app.slice/claude-remote-session.service\n";
    expect(resolveServiceUnitFromCgroup(cgroup)).toBe("claude-remote-session.service");
  });

  it("returns null when the leaf segment is a .scope, not a .service", () => {
    // e.g. self-update.sh's own detached mullion-update-<version> wrapper
    // scope, or a bare `systemd-run --user --scope` invocation.
    const cgroup =
      "0::/user.slice/user-1000.slice/user@1000.service/app.slice/mullion-update-0.1.5.scope\n";
    expect(resolveServiceUnitFromCgroup(cgroup)).toBeNull();
  });

  it("returns null for empty or garbage content", () => {
    expect(resolveServiceUnitFromCgroup("")).toBeNull();
    expect(resolveServiceUnitFromCgroup("   \n")).toBeNull();
    expect(resolveServiceUnitFromCgroup("not a cgroup path at all")).toBeNull();
  });
});

describe("resolveServiceUnit", () => {
  it("prefers an explicit override over cgroup detection", () => {
    const unit = resolveServiceUnit({
      override: "custom.service",
      readCgroup: () => "0::/user.slice/user@1000.service/app.slice/mullion.service",
    });
    expect(unit).toBe("custom.service");
  });

  it("ignores an empty/whitespace override and falls through to detection", () => {
    const unit = resolveServiceUnit({
      override: "   ",
      readCgroup: () => "0::/user.slice/user@1000.service/app.slice/mullion.service",
    });
    expect(unit).toBe("mullion.service");
  });

  it("falls back to cgroup autodetection when no override is set", () => {
    const unit = resolveServiceUnit({
      readCgroup: () => "0::/user.slice/user@1000.service/app.slice/mullion.service",
    });
    expect(unit).toBe("mullion.service");
  });

  it("falls back to the default when the cgroup read throws", () => {
    const unit = resolveServiceUnit({
      readCgroup: () => {
        throw new Error("ENOENT: no such file");
      },
    });
    expect(unit).toBe(DEFAULT_SERVICE_UNIT);
  });

  it("falls back to the default when the cgroup leaf isn't a .service", () => {
    const unit = resolveServiceUnit({
      readCgroup: () => "0::/user.slice/user@1000.service/app.slice/some.scope",
    });
    expect(unit).toBe(DEFAULT_SERVICE_UNIT);
  });
});
