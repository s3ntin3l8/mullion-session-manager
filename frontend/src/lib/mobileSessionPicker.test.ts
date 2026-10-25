import { describe, expect, it } from "vitest";
import { makeProject, makeSession, makeWorkspace } from "../test/fixtures.js";
import type { NotificationEvent } from "../api/index.js";
import { buildPickerSections } from "./mobileSessionPicker.js";
import type { PickerInput } from "./mobileSessionPicker.js";

const attention = (seq: number): NotificationEvent => ({
  seq,
  sessionId: 1,
  kind: "attention",
  ts: 0,
  payload: { attention: true },
});

function input(overrides: Partial<PickerInput> = {}): PickerInput {
  return {
    sessions: [],
    projects: [makeProject({ id: 1, name: "runway" }), makeProject({ id: 2, name: "hermes" })],
    panels: [],
    events: {},
    lastSeenSeq: {},
    dismissedEventKeys: {},
    mutedSessionIds: [],
    hideEndedSessions: false,
    showTaskSessions: true,
    taskSessionIds: new Set(),
    workspaces: [],
    activeWorkspaceId: null,
    ...overrides,
  };
}

describe("buildPickerSections", () => {
  it("groups sessions by project in project order and skips empty projects", () => {
    const sections = buildPickerSections(
      input({
        sessions: [
          makeSession({ id: 1, projectId: 2 }),
          makeSession({ id: 2, projectId: 1 }),
          makeSession({ id: 3, projectId: 2 }),
        ],
      }),
    );
    expect(sections.map((s) => [s.label, s.rows.map((r) => r.session?.id)])).toEqual([
      ["runway", [2]],
      ["hermes", [1, 3]],
    ]);
    expect(
      buildPickerSections(input({ sessions: [makeSession({ id: 1, projectId: 2 })] })),
    ).toHaveLength(1);
  });

  it("applies the sidebar's listing rules but always keeps a session with an open panel", () => {
    const ended = makeSession({ id: 1, projectId: 1, status: "exited" });
    const killed = makeSession({ id: 2, projectId: 1, status: "killed" });
    const hidden = input({
      sessions: [ended, killed],
      hideEndedSessions: true,
    });
    expect(buildPickerSections(hidden)).toEqual([]);
    const open = buildPickerSections({
      ...hidden,
      panels: [{ id: "session-1", title: "ended one", sessionId: 1 }],
    });
    expect(open[0].rows.map((r) => r.session?.id)).toEqual([1]);
    expect(open[0].rows[0]).toMatchObject({ panelId: "session-1", title: "ended one" });
  });

  it("marks a row open only when a panel exists, and titles it from the panel", () => {
    const [section] = buildPickerSections(
      input({
        sessions: [
          makeSession({ id: 1, projectId: 1, lastTitle: "from osc" }),
          makeSession({ id: 2, projectId: 1, lastTitle: "closed one" }),
        ],
        panels: [{ id: "session-1", title: "Tab title", sessionId: 1 }],
      }),
    );
    expect(section.rows[0]).toMatchObject({
      key: "session-1",
      panelId: "session-1",
      title: "Tab title",
    });
    expect(section.rows[1]).toMatchObject({ key: "session-2", panelId: null, title: "closed one" });
  });

  it("lists non-session panels (and panels whose session is unknown) under Open panes", () => {
    const sections = buildPickerSections(
      input({
        sessions: [makeSession({ id: 1, projectId: 1 })],
        panels: [
          { id: "git-1", title: "Git" },
          { id: "session-99", title: "ghost", sessionId: 99 },
        ],
      }),
    );
    expect(sections.map((s) => s.kind)).toEqual(["panes", "project"]);
    expect(sections[0].rows.map((r) => [r.panelId, r.title])).toEqual([
      ["git-1", "Git"],
      ["session-99", "ghost"],
    ]);
  });

  it("pins needs-you sessions first, and also keeps them under their project", () => {
    const sections = buildPickerSections(
      input({
        sessions: [
          makeSession({ id: 1, projectId: 1, attention: false }),
          makeSession({ id: 2, projectId: 2, attention: true }),
        ],
      }),
    );
    expect(sections.map((s) => s.kind)).toEqual(["needs-you", "project", "project"]);
    expect(sections[0].rows.map((r) => r.session?.id)).toEqual([2]);
    expect(sections[2].rows.map((r) => r.session?.id)).toEqual([2]);
  });

  it("derives needs-you and unread from events, and mute suppresses both", () => {
    const base = input({
      sessions: [makeSession({ id: 1, projectId: 1, attention: false })],
      events: { 1: [attention(3)] },
    });
    const [pin, project] = buildPickerSections(base);
    expect(pin.kind).toBe("needs-you");
    expect(project.rows[0]).toMatchObject({ needsYou: true, unreadCount: 1 });

    const [mutedProject] = buildPickerSections({ ...base, mutedSessionIds: [1] });
    expect(mutedProject.kind).toBe("project");
    expect(mutedProject.rows[0]).toMatchObject({ needsYou: false, unreadCount: 0 });
  });

  it("gives every session row search fields: title, command and project name", () => {
    const [section] = buildPickerSections(
      input({ sessions: [makeSession({ id: 1, projectId: 1, command: "codex", lastTitle: "t" })] }),
    );
    expect(section.rows[0].searchFields).toEqual(["t", "codex", "runway"]);
  });

  it("keeps a browser/timeline panel that shares a sessionId separate from the session's own row", () => {
    const sections = buildPickerSections(
      input({
        sessions: [makeSession({ id: 1, projectId: 1 })],
        panels: [
          { id: "browserPane-1", title: "Browser", sessionId: 1 },
          { id: "session-1", title: "shell", sessionId: 1 },
        ],
      }),
    );
    const panes = sections.find((s) => s.kind === "panes");
    expect(panes?.rows.map((r) => r.panelId)).toEqual(["browserPane-1"]);
    const project = sections.find((s) => s.kind === "project");
    expect(project?.rows[0]).toMatchObject({ panelId: "session-1", title: "shell" });
  });

  // #1440 (c) — an open session panel whose project isn't in `projects`
  // (deleted/renamed project, or a stale reference) used to be consumed by
  // `panelBySession` and then never emitted by the project loop, vanishing
  // from every section — only swipe/n-of-N could still reach it.
  it("surfaces an open session panel under Open panes when its project is missing", () => {
    const sections = buildPickerSections(
      input({
        sessions: [makeSession({ id: 1, projectId: 999, command: "codex", lastTitle: "orphan" })],
        panels: [{ id: "session-1", title: "orphan", sessionId: 1 }],
      }),
    );
    expect(sections.map((s) => s.kind)).toEqual(["panes"]);
    expect(sections[0].rows).toEqual([
      expect.objectContaining({
        panelId: "session-1",
        session: expect.objectContaining({ id: 1 }),
      }),
    ]);
  });

  it("pins an orphaned-project session under Needs you too, not just Open panes", () => {
    const sections = buildPickerSections(
      input({
        sessions: [makeSession({ id: 1, projectId: 999, attention: true })],
        panels: [{ id: "session-1", title: "orphan", sessionId: 1 }],
      }),
    );
    expect(sections.map((s) => s.kind)).toEqual(["needs-you", "panes"]);
    expect(sections[0].rows[0]).toMatchObject({ panelId: "session-1", needsYou: true });
    expect(sections[1].rows[0]).toMatchObject({ panelId: "session-1", needsYou: true });
  });

  // #1440 (d) — searchFields used to carry only whichever title was
  // displayed (the panel's, once open) — a renamed tab's live panel title
  // can drift from the locked/OSC name sessionDisplayTitle resolves (and
  // the sidebar's own search matches), so both need to be searchable.
  it("includes both the panel title and sessionDisplayTitle in searchFields when they differ", () => {
    const [section] = buildPickerSections(
      input({
        sessions: [
          makeSession({ id: 1, projectId: 1, command: "codex", lastTitle: "locked name" }),
        ],
        panels: [{ id: "session-1", title: "renamed tab", sessionId: 1 }],
      }),
    );
    expect(section.rows[0]).toMatchObject({ title: "renamed tab" });
    expect(section.rows[0].searchFields).toEqual(["locked name", "codex", "renamed tab", "runway"]);
  });

  // Issue #1882 — the phone tier has no workspace switcher, so a row has to
  // say which workspace its session lives in. The swap the audit called
  // invisible was a session whose panel lived in another workspace's saved
  // layout: opening it replaced the whole layout with nothing on screen
  // saying so, and there was no way back.
  describe("the workspace a session lives in (issue #1882)", () => {
    const layout = (sessionId: number) => ({ sessionId }) as Record<string, unknown>;

    it("names the current workspace for a session tiled in it", () => {
      const sections = buildPickerSections(
        input({
          sessions: [makeSession({ id: 7, projectId: 1 })],
          workspaces: [
            makeWorkspace({ id: 1, name: "Default", layout: layout(7) }),
            makeWorkspace({ id: 2, name: "Work", layout: null }),
          ],
          activeWorkspaceId: 1,
        }),
      );
      expect(sections[0].rows[0].workspace).toEqual({ id: 1, name: "Default", isCurrent: true });
    });

    it("names the other workspace for a session tiled only in it", () => {
      const sections = buildPickerSections(
        input({
          sessions: [makeSession({ id: 7, projectId: 1 })],
          workspaces: [
            makeWorkspace({ id: 1, name: "Default", layout: null }),
            makeWorkspace({ id: 2, name: "Work", layout: layout(7) }),
          ],
          activeWorkspaceId: 1,
        }),
      );
      expect(sections[0].rows[0].workspace).toEqual({ id: 2, name: "Work", isCurrent: false });
    });

    // The current workspace wins over any other claimant: the user is
    // looking at it, so a session tiled there is here — and "here" is the
    // answer that tells the user the swap left the session where they are.
    it("prefers the current workspace when several workspaces claim the session", () => {
      const sections = buildPickerSections(
        input({
          sessions: [makeSession({ id: 7, projectId: 1 })],
          workspaces: [
            makeWorkspace({ id: 1, name: "Default", layout: layout(7) }),
            makeWorkspace({ id: 2, name: "Work", layout: layout(7) }),
          ],
          activeWorkspaceId: 1,
        }),
      );
      expect(sections[0].rows[0].workspace).toEqual({ id: 1, name: "Default", isCurrent: true });
    });

    // With several other claimants and no current one there is no home to
    // name. Picking one would be the arbitrary pick issue #1883 removed, and
    // the opener opens such a session locally anyway rather than swapping.
    it("names no workspace when several other workspaces claim the session", () => {
      const sections = buildPickerSections(
        input({
          sessions: [makeSession({ id: 7, projectId: 1 })],
          workspaces: [
            makeWorkspace({ id: 1, name: "Default", layout: null }),
            makeWorkspace({ id: 2, name: "Work", layout: layout(7) }),
            makeWorkspace({ id: 3, name: "Side", layout: layout(7) }),
          ],
          activeWorkspaceId: 1,
        }),
      );
      expect(sections[0].rows[0].workspace).toBeNull();
    });

    // The phone tier never writes its layout back (issue #1426), so a
    // session open in the live layout is routinely in NO workspace's saved
    // layout. It is still here, so it carries the current workspace.
    it("names the current workspace for a session open in the live layout", () => {
      const sections = buildPickerSections(
        input({
          sessions: [makeSession({ id: 7, projectId: 1 })],
          panels: [{ id: "session-7", title: "open", sessionId: 7 }],
          workspaces: [
            makeWorkspace({ id: 1, name: "Default", layout: null }),
            makeWorkspace({ id: 2, name: "Work", layout: null }),
          ],
          activeWorkspaceId: 1,
        }),
      );
      const row = sections.flatMap((s) => s.rows).find((r) => r.session?.id === 7);
      expect(row?.workspace).toEqual({ id: 1, name: "Default", isCurrent: true });
    });

    it("names no workspace for a session in no workspace and not open", () => {
      const sections = buildPickerSections(
        input({
          sessions: [makeSession({ id: 7, projectId: 1 })],
          workspaces: [makeWorkspace({ id: 1, name: "Default", layout: null })],
          activeWorkspaceId: 1,
        }),
      );
      expect(sections[0].rows[0].workspace).toBeNull();
    });

    // The live grid wins over a stale saved layout. A session open in the
    // current layout is here — the opener focuses that panel, it never
    // swaps — so naming another workspace would promise a swap that never
    // happens.
    it("names the current workspace for a session open in the live grid even when another workspace claims it", () => {
      const sections = buildPickerSections(
        input({
          sessions: [makeSession({ id: 7, projectId: 1 })],
          panels: [{ id: "session-7", title: "open", sessionId: 7 }],
          workspaces: [
            makeWorkspace({ id: 1, name: "Default", layout: null }),
            makeWorkspace({ id: 2, name: "Work", layout: layout(7) }),
          ],
          activeWorkspaceId: 1,
        }),
      );
      const row = sections.flatMap((s) => s.rows).find((r) => r.session?.id === 7);
      expect(row?.workspace).toEqual({ id: 1, name: "Default", isCurrent: true });
    });
  });
});
