import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";

const mockGetStoredSettings = vi.hoisted(() => vi.fn());

vi.mock("../../src/services/settings.js", () => ({
  getStoredSettings: mockGetStoredSettings,
}));

import { resolveWorkerDelegation } from "../../src/services/task-delegation.js";

const app = { log: { warn: vi.fn() }, db: {} } as unknown as FastifyInstance;

const settings = (over: Record<string, unknown> = {}) => ({
  opencode: {
    implementerModel: null,
    reviewerModel: null,
    defaultSmallModel: null,
    delegateModel: null,
  },
  claudeCode: { defaultModel: null, reviewerModel: null, smallModel: null, delegateModel: null },
  codex: { defaultModel: null, reviewerModel: null, delegateModel: null },
  agy: { defaultModel: null, reviewerModel: null, delegateModel: null },
  mcode: { defaultModel: null, reviewerModel: null, delegateModel: null },
  ...over,
});

const task = (over: Record<string, unknown> = {}) => ({
  modelOverride: null,
  body: null as string | null,
  ...over,
});

describe("resolveWorkerDelegation", () => {
  beforeEach(() => {
    mockGetStoredSettings.mockReset();
    mockGetStoredSettings.mockReturnValue(settings());
  });

  it("is null for a plain shell or no command", () => {
    expect(resolveWorkerDelegation(app, "bash", task())).toBeNull();
    expect(resolveWorkerDelegation(app, null, task())).toBeNull();
    expect(resolveWorkerDelegation(app, undefined, task())).toBeNull();
  });

  it("reads the Claude Code delegate model and the worker's resolved model", () => {
    mockGetStoredSettings.mockReturnValue(
      settings({
        claudeCode: {
          defaultModel: "opusplan",
          reviewerModel: null,
          smallModel: null,
          delegateModel: "sonnet",
        },
      }),
    );
    expect(resolveWorkerDelegation(app, "claude", task())).toEqual({
      workerModel: "opusplan",
      delegateModel: "sonnet",
    });
  });

  it("prefers a task's own model, then the issue's Model: line, over the install default", () => {
    mockGetStoredSettings.mockReturnValue(
      settings({
        claudeCode: {
          defaultModel: "sonnet",
          reviewerModel: null,
          smallModel: null,
          delegateModel: "haiku",
        },
      }),
    );
    expect(
      resolveWorkerDelegation(app, "claude", task({ modelOverride: "opus" }))?.workerModel,
    ).toBe("opus");
    expect(
      resolveWorkerDelegation(app, "claude", task({ body: "Model: fable\n\nDo it." }))?.workerModel,
    ).toBe("fable");
  });

  it("leaves the worker model null when the CLI runs on its own default", () => {
    mockGetStoredSettings.mockReturnValue(
      settings({ codex: { defaultModel: null, reviewerModel: null, delegateModel: "gpt-6-luna" } }),
    );
    expect(resolveWorkerDelegation(app, "codex", task())).toEqual({
      workerModel: null,
      delegateModel: "gpt-6-luna",
    });
  });

  it("treats an invalid stored delegate model as unset", () => {
    mockGetStoredSettings.mockReturnValue(
      settings({
        claudeCode: {
          defaultModel: null,
          reviewerModel: null,
          smallModel: null,
          delegateModel: "sonnet; rm -rf /",
        },
      }),
    );
    expect(resolveWorkerDelegation(app, "claude", task())?.delegateModel).toBeNull();
  });

  it("resolves opencode through its implementer model and provider/model delegate", () => {
    mockGetStoredSettings.mockReturnValue(
      settings({
        opencode: {
          implementerModel: "anthropic/claude-opus-5-5",
          reviewerModel: null,
          defaultSmallModel: null,
          delegateModel: "anthropic/claude-sonnet-5-5",
        },
      }),
    );
    expect(resolveWorkerDelegation(app, "opencode", task())).toEqual({
      workerModel: "anthropic/claude-opus-5-5",
      delegateModel: "anthropic/claude-sonnet-5-5",
    });
  });

  it("drops an opencode delegate that is not provider/model", () => {
    mockGetStoredSettings.mockReturnValue(
      settings({
        opencode: {
          implementerModel: null,
          reviewerModel: null,
          defaultSmallModel: null,
          delegateModel: "sonnet",
        },
      }),
    );
    expect(resolveWorkerDelegation(app, "opencode", task())?.delegateModel).toBeNull();
  });
});
