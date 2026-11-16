import { describe, it, expect } from "vitest";
import {
  claudeModelTier,
  claudeTaskModelAlias,
  codexModelTier,
  delegationApplies,
} from "../../../src/services/hook-adapters/delegation.js";

describe("claudeModelTier", () => {
  it("ranks the families haiku < sonnet < opus < fable", () => {
    expect(claudeModelTier("haiku")).toBeLessThan(claudeModelTier("sonnet")!);
    expect(claudeModelTier("sonnet")).toBeLessThan(claudeModelTier("opus")!);
    expect(claudeModelTier("opus")).toBeLessThan(claudeModelTier("fable")!);
  });

  it("matches full ids and ignores the 1M-context suffix and case", () => {
    expect(claudeModelTier("claude-opus-5-5")).toBe(claudeModelTier("opus"));
    expect(claudeModelTier("claude-sonnet-5-5")).toBe(claudeModelTier("sonnet"));
    expect(claudeModelTier("claude-fable-5-2")).toBe(claudeModelTier("fable"));
    expect(claudeModelTier("Sonnet[1m]")).toBe(claudeModelTier("sonnet"));
  });

  it("ranks opusplan as Sonnet, because a worker is never in plan mode", () => {
    expect(claudeModelTier("opusplan")).toBe(claudeModelTier("sonnet"));
    expect(claudeModelTier("opusplan[1m]")).toBe(claudeModelTier("sonnet"));
  });

  it("does not rank a name it does not know", () => {
    expect(claudeModelTier("my-custom-model")).toBeNull();
  });
});

describe("claudeTaskModelAlias", () => {
  it("maps any stored name to the four aliases the Task tool's model enum accepts", () => {
    expect(claudeTaskModelAlias("sonnet")).toBe("sonnet");
    expect(claudeTaskModelAlias("sonnet[1m]")).toBe("sonnet");
    expect(claudeTaskModelAlias("claude-haiku-5-5")).toBe("haiku");
    expect(claudeTaskModelAlias("claude-opus-5-5")).toBe("opus");
    expect(claudeTaskModelAlias("fable")).toBe("fable");
    expect(claudeTaskModelAlias("opusplan")).toBe("sonnet");
    expect(claudeTaskModelAlias("my-custom-model")).toBeNull();
  });
});

describe("codexModelTier", () => {
  it("ranks luna < terra < sol < astra and leaves other names unranked", () => {
    expect(codexModelTier("gpt-6-luna")).toBeLessThan(codexModelTier("gpt-6.1-terra")!);
    expect(codexModelTier("gpt-6.1-terra")).toBeLessThan(codexModelTier("gpt-6.1-sol")!);
    expect(codexModelTier("gpt-6.1-sol")).toBeLessThan(codexModelTier("gpt-6-astra")!);
    expect(codexModelTier("codex-auto-review")).toBeNull();
  });
});

describe("delegationApplies", () => {
  const rank = claudeModelTier;

  it("is false with no delegate model, whatever the worker runs", () => {
    expect(delegationApplies({ workerModel: "opus", delegateModel: null }, rank)).toBe(false);
    expect(delegationApplies({ workerModel: null, delegateModel: "  " }, rank)).toBe(false);
  });

  it("is true when the worker's own model is unknown", () => {
    expect(delegationApplies({ workerModel: null, delegateModel: "sonnet" }, rank)).toBe(true);
  });

  it("is false when worker and delegate are the same model", () => {
    expect(delegationApplies({ workerModel: "Sonnet", delegateModel: "sonnet" }, undefined)).toBe(
      false,
    );
  });

  it("requires the delegate to be strictly cheaper when both are ranked", () => {
    expect(delegationApplies({ workerModel: "opus", delegateModel: "sonnet" }, rank)).toBe(true);
    expect(delegationApplies({ workerModel: "sonnet", delegateModel: "opus" }, rank)).toBe(false);
    expect(delegationApplies({ workerModel: "opusplan", delegateModel: "sonnet" }, rank)).toBe(
      false,
    );
  });

  it("shows the clause when either model cannot be ranked", () => {
    expect(delegationApplies({ workerModel: "opus", delegateModel: "custom-x" }, rank)).toBe(true);
    expect(delegationApplies({ workerModel: "custom-y", delegateModel: "sonnet" }, rank)).toBe(
      true,
    );
    expect(delegationApplies({ workerModel: "a/b", delegateModel: "c/d" }, undefined)).toBe(true);
  });
});
