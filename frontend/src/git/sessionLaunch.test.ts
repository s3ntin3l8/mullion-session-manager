// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { openSessionOn } from "./sessionLaunch.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { useDashboardStore } from "../store/index.js";

describe("openSessionOn", () => {
  afterEach(() => vi.unstubAllGlobals());

  const setup = (skipPermissionsAgents: string[]) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(200, [{ id: "agent:claude", kind: "agent", command: "claude" }]),
        ),
    );
    const createSession = vi.fn().mockResolvedValue({ id: 4 });
    const requestOpenSession = vi.fn();
    const { settings } = useDashboardStore.getState();
    useDashboardStore.setState({
      createSession,
      requestOpenSession,
      settings: {
        ...settings,
        launchers: { ...settings.launchers, defaultAgent: "claude", skipPermissionsAgents },
      },
    });
    return { createSession, requestOpenSession };
  };

  it("passes skipPermissions: true for an agent the settings list", async () => {
    const { createSession, requestOpenSession } = setup(["claude"]);
    await openSessionOn(1, { branch: "feat" });
    expect(createSession).toHaveBeenCalledWith(1, "claude", {
      worktree: { branch: "feat" },
      skipPermissions: true,
    });
    expect(requestOpenSession).toHaveBeenCalledWith(4);
  });

  it("passes skipPermissions: false otherwise, for a cwd target too", async () => {
    const { createSession } = setup([]);
    await openSessionOn(1, { cwd: "/tmp/wt" });
    expect(createSession).toHaveBeenCalledWith(1, "claude", {
      cwd: "/tmp/wt",
      skipPermissions: false,
    });
  });
});
