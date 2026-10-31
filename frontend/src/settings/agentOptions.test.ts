import { describe, it, expect } from "vitest";
import {
  REVIEW_AGENT_OPTIONS,
  hermesReviewerAvailable,
  reviewAgentOptions,
  withCurrentReviewAgent,
} from "./agentOptions.js";

const relay = { provider: "hermes", apiUrl: "http://h:1", taskMasterReviewer: true };

describe("hermesReviewerAvailable", () => {
  it("is on only with the setting, the hermes provider and a URL", () => {
    expect(hermesReviewerAvailable(relay)).toBe(true);
    expect(hermesReviewerAvailable({ ...relay, taskMasterReviewer: false })).toBe(false);
    expect(hermesReviewerAvailable({ ...relay, provider: "none" })).toBe(false);
    expect(hermesReviewerAvailable({ ...relay, apiUrl: "" })).toBe(false);
    expect(hermesReviewerAvailable(undefined)).toBe(false);
  });
});

describe("reviewAgentOptions", () => {
  it("offers Hermes only when available", () => {
    expect(reviewAgentOptions(true).map((o) => o.value)).toContain("hermes");
    expect(reviewAgentOptions(false)).toBe(REVIEW_AGENT_OPTIONS);
  });
});

describe("withCurrentReviewAgent", () => {
  it("keeps a stored hermes value renderable when the setting is off", () => {
    const opts = withCurrentReviewAgent(reviewAgentOptions(false), "hermes");
    expect(opts.find((o) => o.value === "hermes")?.label).toBe("Hermes (Task Master reviews off)");
  });
  it("labels other unknown values as not detected and leaves known ones", () => {
    expect(withCurrentReviewAgent(REVIEW_AGENT_OPTIONS, "foo").at(-1)?.label).toBe(
      "foo (not detected)",
    );
    expect(withCurrentReviewAgent(REVIEW_AGENT_OPTIONS, "claude")).toBe(REVIEW_AGENT_OPTIONS);
  });
});
