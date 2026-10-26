import { describe, expect, it } from "vitest";
import type { GitHubPrPhase } from "../api/types.js";
import { legacyDotClass, legacyPillClass, runStatusText, statusTone } from "./statusTone.js";

describe("statusTone", () => {
  it.each<[GitHubPrPhase, string]>([
    ["ci_failing", "danger"],
    ["changes_requested", "danger"],
    ["conflicts", "danger"],
    ["review_pending", "warn"],
    ["ci_pending", "warn"],
    ["ready_to_merge", "success"],
    ["draft", "neutral"],
    ["unknown", "neutral"],
  ])("phase %s -> %s", (phase, tone) => {
    expect(statusTone({ phase })).toBe(tone);
  });

  it("maps the aggregate CI read", () => {
    expect(statusTone({ ci: "success" })).toBe("success");
    expect(statusTone({ ci: "failure" })).toBe("danger");
    expect(statusTone({ ci: "in_progress" })).toBe("warn");
    expect(statusTone({ ci: null })).toBe("neutral");
    expect(statusTone({ ci: undefined })).toBe("neutral");
  });

  it("maps a single check run", () => {
    expect(statusTone({ status: "in_progress", conclusion: null })).toBe("warn");
    expect(statusTone({ status: "completed", conclusion: "success" })).toBe("success");
    expect(statusTone({ status: "completed", conclusion: "skipped" })).toBe("neutral");
    expect(statusTone({ status: "completed", conclusion: "cancelled" })).toBe("neutral");
    expect(statusTone({ status: "completed", conclusion: "failure" })).toBe("danger");
    expect(statusTone({ status: "completed", conclusion: null })).toBe("danger");
  });

  it("spells legacy class names from the same decision", () => {
    expect(legacyDotClass("success")).toBe("good");
    expect(legacyDotClass("danger")).toBe("bad");
    expect(legacyDotClass("warn")).toBe("pending");
    expect(legacyDotClass("merged")).toBe("none");
    expect(legacyPillClass("success")).toBe("good");
    expect(legacyPillClass("danger")).toBe("bad");
    expect(legacyPillClass("warn")).toBe("warn");
    expect(legacyPillClass("info")).toBe("dim");
  });

  it("words a run's state", () => {
    expect(runStatusText("completed", "failure")).toBe("failure");
    expect(runStatusText("completed", null)).toBe("unknown");
    expect(runStatusText("queued", null)).toBe("queued");
  });
});
