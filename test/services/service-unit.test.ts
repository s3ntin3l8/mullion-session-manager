import { describe, it, expect } from "vitest";
import {
  resolveServiceUnitFromCgroup,
  resolveServiceUnit,
  launchdLabelForRole,
  DEFAULT_SERVICE_UNIT,
  DEFAULT_LAUNCHD_LABEL,
} from "../../src/services/service-unit.js";

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

describe("resolveServiceUnit on macOS (issue #1718)", () => {
  it("resolves the launchd LABEL, not a systemd unit name", () => {
    // There are no cgroups on darwin, so the cgroup path cannot resolve
    // anything there — the label comes from the install's own
    // MULLION_SERVICE_UNIT (the installer writes it into the plist) or from
    // the role.
    expect(resolveServiceUnit({ platform: "darwin" })).toBe(DEFAULT_LAUNCHD_LABEL);
    expect(resolveServiceUnit({ platform: "darwin", role: "agent" })).toBe("com.mullion.agent");
    expect(resolveServiceUnit({ platform: "darwin", role: "primary" })).toBe("com.mullion.primary");
  });

  it("prefers the explicit override over the role-derived default", () => {
    expect(
      resolveServiceUnit({ platform: "darwin", role: "agent", override: "com.example.custom" }),
    ).toBe("com.example.custom");
  });

  it("never consults the cgroup on darwin", () => {
    // Even a cgroup file that would resolve a unit must be ignored: on
    // darwin there is no systemd unit to restart.
    let read = false;
    const unit = resolveServiceUnit({
      platform: "darwin",
      role: "primary",
      cgroupPath: "/proc/self/cgroup",
      readCgroup: () => {
        read = true;
        return "0::/user.slice/user-1000.slice/mullion.service\n";
      },
    });
    expect(read).toBe(false);
    expect(unit).toBe("com.mullion.primary");
  });

  it("keeps resolving a systemd unit on linux", () => {
    expect(
      resolveServiceUnit({
        platform: "linux",
        readCgroup: () => "0::/user.slice/mullion.service\n",
      }),
    ).toBe("mullion.service");
  });
});

describe("launchdLabelForRole", () => {
  it("maps the two roles to their labels, and anything else to the primary's", () => {
    expect(launchdLabelForRole("primary")).toBe("com.mullion.primary");
    expect(launchdLabelForRole("agent")).toBe("com.mullion.agent");
    expect(launchdLabelForRole("")).toBe("com.mullion.primary");
  });
});
