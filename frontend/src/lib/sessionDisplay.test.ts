import { describe, expect, it } from "vitest";
import { makeProject, makeSession } from "../test/fixtures.js";
import { sessionDisplayTitle, sessionMatchesSearch } from "./sessionDisplay.js";

describe("sessionDisplayTitle", () => {
  it("prefers the locked name when nameLocked is true and name is set", () => {
    const session = makeSession({ nameLocked: true, name: "My Session", lastTitle: "OSC title" });
    expect(sessionDisplayTitle(session)).toBe("My Session");
  });

  it("falls back to lastTitle when not name-locked", () => {
    const session = makeSession({ nameLocked: false, name: "ignored", lastTitle: "OSC title" });
    expect(sessionDisplayTitle(session)).toBe("OSC title");
  });

  it("falls back to lastTitle when nameLocked is true but name is null", () => {
    const session = makeSession({ nameLocked: true, name: null, lastTitle: "OSC title" });
    expect(sessionDisplayTitle(session)).toBe("OSC title");
  });

  it("falls back to command when neither name nor lastTitle is set", () => {
    const session = makeSession({
      nameLocked: false,
      name: null,
      lastTitle: null,
      command: "npm run dev",
    });
    expect(sessionDisplayTitle(session)).toBe("npm run dev");
  });

  it("falls back to command when nameLocked is true but name is an empty string", () => {
    const session = makeSession({
      nameLocked: true,
      name: "",
      lastTitle: null,
      command: "npm run dev",
    });
    expect(sessionDisplayTitle(session)).toBe("npm run dev");
  });
});

describe("sessionMatchesSearch", () => {
  const project = makeProject({ name: "mullion-session-manager" });

  it("matches on the session's displayed title, case-insensitively", () => {
    const session = makeSession({ nameLocked: true, name: "Fix the Sidebar" });
    expect(sessionMatchesSearch(session, project, "sidebar")).toBe(true);
    expect(sessionMatchesSearch(session, project, "SIDEBAR")).toBe(true);
  });

  it("matches on the raw command even when a display title overrides it", () => {
    const session = makeSession({
      nameLocked: true,
      name: "Fix the Sidebar",
      command: "claude --dangerously-skip-permissions",
    });
    expect(sessionMatchesSearch(session, project, "dangerously")).toBe(true);
  });

  it("matches on the project's name", () => {
    const session = makeSession({ command: "claude code" });
    expect(sessionMatchesSearch(session, project, "mullion")).toBe(true);
  });

  it("returns false when the query matches none of the three fields", () => {
    const session = makeSession({ command: "claude code" });
    expect(sessionMatchesSearch(session, project, "nonexistent")).toBe(false);
  });

  it("returns true for an empty query (every field passes a blank substring check)", () => {
    const session = makeSession({ command: "claude code" });
    expect(sessionMatchesSearch(session, project, "")).toBe(true);
  });
});
