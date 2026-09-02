import { describe, it, expect } from "vitest";
import { openCodeAdapter } from "../../../src/services/hook-adapters/opencode.js";

const baseCtx = {
  sessionId: "test",
  sessionsDir: "/tmp",
  hookSocketPath: "/tmp/sock",
  hookToken: "tok",
  controlSocketPath: "/tmp/ctrl",
  forwarderPath: "/tmp/fwd",
  injectAgentGuide: false,
  injectProjectBriefing: false,
  injectMullionBundle: false,
};

describe("opencode adapter configContent.model", () => {
  it("omits the model key when ctx.model is unset", () => {
    const plan = openCodeAdapter.prepareLaunch({ ...baseCtx, cwd: "/tmp" });
    const cc = JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT!);
    expect(cc.model).toBeUndefined();
  });

  it("sets configContent.model when ctx.model is set", () => {
    const plan = openCodeAdapter.prepareLaunch({
      ...baseCtx,
      cwd: "/tmp",
      model: "opencode-go/foo",
    });
    const cc = JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT!);
    expect(cc.model).toBe("opencode-go/foo");
  });
});
