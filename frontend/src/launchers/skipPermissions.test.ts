import { describe, expect, it } from "vitest";
import { resolveSkipPermissions } from "./skipPermissions.js";

const settings = (agents?: string[]) => ({ launchers: { skipPermissionsAgents: agents } });
const agent = (skipPermissions?: boolean) => ({
  id: "agent:claude",
  kind: "agent" as const,
  skipPermissions,
});

describe("resolveSkipPermissions", () => {
  it("is undefined for a non-agent launcher", () => {
    expect(
      resolveSkipPermissions(
        { id: "action:x", kind: "action" as never },
        settings(["claude"]),
        true,
      ),
    ).toBeUndefined();
  });

  it("prefers an explicit override over everything", () => {
    expect(resolveSkipPermissions(agent(false), settings(["claude"]), true)).toBe(true);
    expect(resolveSkipPermissions(agent(true), settings(["claude"]), false)).toBe(false);
  });

  it("lets the launcher's true win over a setting that omits the agent", () => {
    expect(resolveSkipPermissions(agent(true), settings([]))).toBe(true);
  });

  it("lets the launcher's false win over a setting that lists the agent", () => {
    expect(resolveSkipPermissions(agent(false), settings(["claude"]))).toBe(false);
  });

  it("falls back to the setting's agent list", () => {
    expect(resolveSkipPermissions(agent(), settings(["claude"]), null)).toBe(true);
    expect(resolveSkipPermissions(agent(), settings(["codex"]))).toBe(false);
    expect(resolveSkipPermissions(agent(), settings(undefined))).toBe(false);
  });
});
