import { describe, it, expect, vi } from "vitest";

// Separate test file: vi.mock scoping is file-level, so this file's mocked zod
// never leaks into opencode-plugin.test.ts's tests (which test the real zod path).
// Verifies the try/catch fallback in MullionHookEmitter: when zod is unavailable
// the promote_to_worktree tool is silently skipped.
vi.mock("zod", () => ({}));

describe("MullionHookEmitter without zod (issue #271 fallback)", () => {
  it("does not register promote_to_worktree tool", async () => {
    const { MullionHookEmitter } = await import("../../src/hooks/opencode-plugin.js");
    const hooks = await MullionHookEmitter();
    expect(hooks.tool).toEqual({});
  });

  it("still registers event hook even without zod", async () => {
    const { MullionHookEmitter } = await import("../../src/hooks/opencode-plugin.js");
    const hooks = await MullionHookEmitter();
    expect(typeof hooks.event).toBe("function");
  });
});
