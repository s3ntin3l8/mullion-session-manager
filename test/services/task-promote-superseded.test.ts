import { describe, it, expect, vi } from "vitest";
import { openDraftPRForTask } from "../../src/services/task-promote.js";

// #2522 — the guard returns before touching git or GitHub, so no mocks needed.
describe("openDraftPRForTask for a superseded task", () => {
  it("is never promoted", async () => {
    const app = { config: {}, log: { warn: vi.fn() } } as never;
    const result = await openDraftPRForTask(
      app,
      { id: 1, supersededAt: new Date() } as never,
      { id: 1 } as never,
    );
    expect(result).toMatchObject({ ok: false, reason: "no-repo" });
  });
});
