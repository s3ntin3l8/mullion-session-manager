import { describe, expect, it } from "vitest";
import type { NotificationEvent } from "../api/index.js";
import { makeProject, makeSession } from "../test/fixtures.js";
import { buildRailPaneEntries, railLabel, railPaneAccessibleName } from "./railPanes.js";
import type { RailPaneContext } from "./railPanes.js";

describe("railLabel", () => {
  it.each([
    ["claude · login fix", "claude", "login"],
    ["task #7 worker", "claude", "#7"],
    ["fake-agent.sh", "./fake-agent.sh", "fake-agent"],
    ["codex: orders query", "codex --yolo", "orders"],
    ["npm run dev", "npm run dev", "run"],
    ["Release notes", undefined, "Release"],
  ])("%s → %s", (title, command, expected) => {
    expect(railLabel(title, command)).toBe(expected);
  });

  it("keeps the agent's name when it is the whole title", () => {
    expect(railLabel("claude", "claude")).toBe("claude");
  });

  it("falls back to the title when nothing is a word", () => {
    expect(railLabel("··", "zsh")).toBe("··");
  });
});

const ctx = (over: Partial<RailPaneContext> = {}): RailPaneContext => ({
  sessions: [],
  projects: [],
  events: {},
  lastSeenSeq: {},
  dismissedEventKeys: {},
  mutedSessionIds: [],
  theme: "dark",
  activePanelId: null,
  ...over,
});

const attention = (sessionId: number, seq: number) =>
  ({
    seq,
    sessionId,
    kind: "attention",
    payload: { attention: true },
    at: "2026-10-01T09:00:00Z",
  }) as unknown as NotificationEvent;

describe("buildRailPaneEntries", () => {
  it("builds a session's entry: title, project, logo, needs-you, unread, focus", () => {
    const session = makeSession({
      id: 4,
      projectId: 2,
      command: "claude",
      lastTitle: "claude · login fix",
      attention: true,
    });
    const [entry] = buildRailPaneEntries(
      [{ id: "session-4", title: "x", sessionId: 4 }],
      ctx({
        sessions: [session],
        projects: [makeProject({ id: 2, name: "aurora-web" })],
        events: { 4: [attention(4, 3), attention(4, 5)] },
        lastSeenSeq: { 4: 3 },
        activePanelId: "session-4",
      }),
    );
    expect(entry).toMatchObject({
      panelId: "session-4",
      label: "login",
      fullTitle: "claude · login fix",
      projectName: "aurora-web",
      isSession: true,
      needsYou: true,
      unreadCount: 1,
      active: true,
    });
    expect(entry.logo).toEqual(expect.any(String));
    expect(railPaneAccessibleName(entry)).toBe(
      "claude · login fix — aurora-web, needs you, 1 unread",
    );
  });

  it("drops needs-you and unread for a muted session", () => {
    const session = makeSession({ id: 4, attention: true });
    const [entry] = buildRailPaneEntries(
      [{ id: "session-4", title: "", sessionId: 4 }],
      ctx({
        sessions: [session],
        events: { 4: [attention(4, 5)] },
        mutedSessionIds: [4],
      }),
    );
    expect(entry.needsYou).toBe(false);
    expect(entry.unreadCount).toBe(0);
    expect(entry.active).toBe(false);
  });

  it("names a non-terminal pane by its tab title, with no logo or project", () => {
    const [entry] = buildRailPaneEntries(
      [{ id: "git-2", title: "Git · aurora", sessionId: undefined }],
      ctx(),
    );
    expect(entry).toMatchObject({
      label: "Git",
      fullTitle: "Git · aurora",
      projectName: null,
      logo: null,
      isSession: false,
      needsYou: false,
      unreadCount: 0,
    });
    expect(railPaneAccessibleName(entry)).toBe("Git · aurora");
  });

  it("keeps the order it is given", () => {
    const entries = buildRailPaneEntries(
      [
        { id: "b", title: "Beta", sessionId: undefined },
        { id: "a", title: "Alpha", sessionId: undefined },
      ],
      ctx(),
    );
    expect(entries.map((e) => e.panelId)).toEqual(["b", "a"]);
  });
});
