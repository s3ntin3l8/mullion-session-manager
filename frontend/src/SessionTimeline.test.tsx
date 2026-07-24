// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionTimeline } from "./SessionTimeline.js";
import type { NotificationEvent, Session } from "./api.js";

let sessions: Session[];
let events: Record<number, NotificationEvent[]>;

function storeState() {
  return { sessions, events };
}

vi.mock("./store.js", () => {
  const useDashboardStore = (selector: (s: unknown) => unknown) => selector(storeState());
  return { useDashboardStore };
});

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 1,
    projectId: 1,
    name: "claude code",
    nameLocked: true,
    command: "claude code",
    cwd: null,
    liveCwd: null,
    kind: "terminal",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastAttachedAt: "2026-01-01T00:00:00.000Z",
    alive: true,
    subscriberCount: 1,
    activity: "idle",
    lastActivityAt: Date.now(),
    attention: false,
    attentionAt: null,
    lastTitle: null,
    gateState: "idle",
    gatePrompt: null,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    seq: 1,
    sessionId: 1,
    kind: "attention",
    ts: Date.now(),
    payload: { attention: true, signal: "bell" },
    ...overrides,
  };
}

beforeEach(() => {
  sessions = [makeSession()];
  events = {};
});

describe("SessionTimeline (issue #212)", () => {
  it("shows a not-found message when the session isn't tracked", () => {
    sessions = [];
    render(<SessionTimeline params={{ sessionId: 1 }} />);
    expect(screen.getByText("Session not found.")).toBeInTheDocument();
  });

  it("shows an empty state when the session has no events", () => {
    render(<SessionTimeline params={{ sessionId: 1 }} />);
    expect(screen.getByText("No events yet.")).toBeInTheDocument();
  });

  it("renders one row per describable event, oldest first (store order)", () => {
    events = {
      1: [
        makeEvent({ seq: 1, ts: 1000 }),
        makeEvent({
          seq: 2,
          ts: 2000,
          kind: "file_change",
          payload: { path: "src/a.ts", action: "modify" },
        }),
      ],
    };
    render(<SessionTimeline params={{ sessionId: 1 }} />);

    const rows = screen.getAllByText(/Bell|Changed src\/a\.ts/);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Bell");
    expect(rows[1]).toHaveTextContent("Changed src/a.ts");
  });

  it("drops events describeEvent can't describe (e.g. a bare title_change with no title)", () => {
    events = {
      1: [makeEvent({ seq: 1, kind: "title_change", payload: {} })],
    };
    render(<SessionTimeline params={{ sessionId: 1 }} />);
    expect(screen.getByText("No events yet.")).toBeInTheDocument();
  });

  it("filters by kind via the chip toggles", async () => {
    events = {
      1: [
        makeEvent({ seq: 1 }),
        makeEvent({
          seq: 2,
          kind: "file_change",
          payload: { path: "src/a.ts", action: "modify" },
        }),
      ],
    };
    render(<SessionTimeline params={{ sessionId: 1 }} />);
    expect(screen.getByText("Bell")).toBeInTheDocument();
    expect(screen.getByText("Changed src/a.ts")).toBeInTheDocument();

    // Untoggling "Files" hides the file_change row without touching the
    // attention one.
    await userEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(screen.getByText("Bell")).toBeInTheDocument();
    expect(screen.queryByText("Changed src/a.ts")).not.toBeInTheDocument();
  });

  it("shows the filtered-empty message once every kind is toggled off", async () => {
    events = { 1: [makeEvent({ seq: 1 })] };
    render(<SessionTimeline params={{ sessionId: 1 }} />);

    await userEvent.click(screen.getByRole("button", { name: "Attention" }));

    expect(screen.getByText("No events match the current filter.")).toBeInTheDocument();
  });

  it("searches the described text, case-insensitively", async () => {
    events = {
      1: [
        makeEvent({ seq: 1 }),
        makeEvent({
          seq: 2,
          kind: "file_change",
          payload: { path: "src/Widget.tsx", action: "create" },
        }),
      ],
    };
    render(<SessionTimeline params={{ sessionId: 1 }} />);

    await userEvent.type(screen.getByLabelText("Search timeline"), "widget");

    expect(screen.queryByText("Bell")).not.toBeInTheDocument();
    expect(screen.getByText("Created src/Widget.tsx")).toBeInTheDocument();
  });

  it("search and kind filters combine (both must match)", async () => {
    events = {
      1: [
        makeEvent({ seq: 1 }),
        makeEvent({
          seq: 2,
          kind: "file_change",
          payload: { path: "src/bell-widget.ts", action: "modify" },
        }),
      ],
    };
    render(<SessionTimeline params={{ sessionId: 1 }} />);

    await userEvent.type(screen.getByLabelText("Search timeline"), "bell");
    // Both rows match the text search ("Bell" and ".../bell-widget.ts"), but
    // untoggling "Attention" should still remove only that one.
    await userEvent.click(screen.getByRole("button", { name: "Attention" }));

    expect(screen.queryByText("Bell")).not.toBeInTheDocument();
    expect(screen.getByText("Changed src/bell-widget.ts")).toBeInTheDocument();
  });
});
