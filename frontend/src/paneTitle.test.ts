import { describe, it, expect } from "vitest";
import { formatBranchLabel, formatPaneTitle, initialPaneTitle } from "./paneTitle.js";
import type { Session } from "./api.js";

// Minimal fixture matching api.ts's Session shape — same convention as
// attention.test.ts's makeSession, only the title-relevant fields vary.
function makeSession(overrides: Partial<Session>): Session {
  return {
    id: 1,
    projectId: 1,
    name: null,
    nameLocked: false,
    command: "bash",
    cwd: null,
    liveCwd: null,
    kind: "terminal",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastAttachedAt: null,
    alive: true,
    subscriberCount: 0,
    activity: "idle",
    lastActivityAt: null,
    attention: false,
    attentionAt: null,
    lastTitle: null,
    gateState: "idle",
    gatePrompt: null,
    promoteState: "idle",
    promoteSummary: null,
    promoteSuggestedBaseRef: null,
    ...overrides,
  };
}

describe("formatPaneTitle", () => {
  it("appends the project name with a middot separator", () => {
    expect(formatPaneTitle("opencode", "my-project")).toBe("opencode · my-project");
  });

  it("returns the bare title when there's no project name", () => {
    expect(formatPaneTitle("opencode", undefined)).toBe("opencode");
  });
});

describe("initialPaneTitle", () => {
  it("falls back to the raw command for an unnamed, untitled session", () => {
    const session = makeSession({
      name: null,
      nameLocked: false,
      command: "bash",
      lastTitle: null,
    });
    expect(initialPaneTitle(session, "my-project")).toBe("bash");
  });

  it("uses the launch-pattern name when present and not locked", () => {
    const session = makeSession({
      name: "claude · my-project",
      nameLocked: false,
      lastTitle: null,
    });
    expect(initialPaneTitle(session, "my-project")).toBe("claude · my-project");
  });

  it("seeds from session.lastTitle (reattach) when the name isn't locked", () => {
    const session = makeSession({
      name: "claude · my-project",
      nameLocked: false,
      lastTitle: "opencode",
    });
    expect(initialPaneTitle(session, "my-project")).toBe("opencode · my-project");
  });

  it("pins to the explicit rename even when lastTitle is present (issue #69)", () => {
    const session = makeSession({
      name: "my work",
      nameLocked: true,
      lastTitle: "opencode",
    });
    expect(initialPaneTitle(session, "my-project")).toBe("my work");
  });

  it("falls back past a locked-but-empty name (defensive; shouldn't happen via the rename route)", () => {
    const session = makeSession({ name: null, nameLocked: true, lastTitle: "opencode" });
    expect(initialPaneTitle(session, "my-project")).toBe("opencode · my-project");
  });
});

describe("formatBranchLabel", () => {
  it("returns the bare branch name when clean", () => {
    expect(formatBranchLabel("main", false)).toBe("main");
  });

  it("appends a trailing asterisk when dirty", () => {
    expect(formatBranchLabel("main", true)).toBe("main *");
  });

  it("returns null when there's no known branch, regardless of dirty state", () => {
    expect(formatBranchLabel(null, false)).toBeNull();
    expect(formatBranchLabel(null, true)).toBeNull();
  });
});
