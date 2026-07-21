// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionRow } from "./Sidebar.js";
import type { Session } from "./api.js";

// ConfirmButton checks settings.sessions.confirmBeforeKill from the store —
// default it to false so the test doesn't need a full store hydrate.
vi.mock("./store.js", () => ({
  useDashboardStore: (selector: (s: unknown) => unknown) =>
    selector({
      settings: { sessions: { confirmBeforeKill: false } },
      theme: "dark",
    }),
}));

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: 1,
    projectId: 1,
    name: null,
    nameLocked: false,
    command: "claude code",
    cwd: null,
    kind: "terminal",
    status: "active",
    createdAt: "",
    lastAttachedAt: null,
    alive: true,
    subscriberCount: 0,
    activity: "working",
    lastActivityAt: Date.now(),
    attention: false,
    attentionAt: null,
    lastTitle: null,
    ...overrides,
  };
}

// jsdom doesn't implement DataTransfer/DragEvent; provide minimal stubs.
function createDataTransfer(): DataTransfer {
  const map = new Map<string, string>();
  return {
    setData(type, val) {
      map.set(type, val);
    },
    getData(type) {
      return map.get(type) ?? "";
    },
    get types() {
      return Array.from(map.keys());
    },
    effectAllowed: "none" as DataTransfer["effectAllowed"],
    dropEffect: "none" as DataTransfer["dropEffect"],
    clearData(format) {
      if (format) map.delete(format);
      else map.clear();
    },
    setDragImage() {},
    items: {} as DataTransfer["items"],
    files: {} as FileList,
  } as DataTransfer;
}

function createDragEvent(type: string, dataTransfer: DataTransfer): DragEvent {
  const event = new Event(type, { bubbles: true }) as unknown as DragEvent;
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  return event;
}

const SESSION: Session = {
  id: 42,
  projectId: 1,
  name: null,
  nameLocked: false,
  command: "claude code",
  cwd: null,
  kind: "terminal",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastAttachedAt: "2026-01-01T00:00:00.000Z",
  alive: true,
  subscriberCount: 1,
  activity: "working",
  lastActivityAt: Date.now(),
  attention: false,
  attentionAt: null,
  lastTitle: null,
};

describe("SessionRow", () => {
  it("sets application/x-tessera-session on drag start", () => {
    const onOpen = vi.fn();
    const onEnd = vi.fn();

    render(<SessionRow session={SESSION} onOpen={onOpen} onEnd={onEnd} />);

    const row = screen.getByText("claude code").closest(".session-item")!;

    const dataTransfer = createDataTransfer();
    row.dispatchEvent(createDragEvent("dragstart", dataTransfer));

    expect(dataTransfer.getData("application/x-tessera-session")).toBe("42");
    expect(dataTransfer.getData("text/plain")).toBe("claude code");
    expect(dataTransfer.effectAllowed).toBe("move");
  });

  it("fires onClick on a plain click (not a drag)", async () => {
    const onOpen = vi.fn();
    const onEnd = vi.fn();
    const user = userEvent.setup();

    render(<SessionRow session={SESSION} onOpen={onOpen} onEnd={onEnd} />);

    const row = screen.getByText("claude code").closest(".session-item")!;
    await user.click(row);

    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("SessionRow title display", () => {
  it("shows command when no name and no lastTitle", () => {
    render(
      <SessionRow
        session={makeSession({ command: "npm run build" })}
        onOpen={vi.fn()}
        onEnd={vi.fn()}
      />,
    );
    expect(screen.getByText("npm run build")).toBeTruthy();
  });

  it("shows lastTitle when present and not locked", () => {
    render(
      <SessionRow
        session={makeSession({
          name: "Claude Code · my-project",
          command: "claude -p 'fix bug'",
          lastTitle: "fixing the bug",
        })}
        onOpen={vi.fn()}
        onEnd={vi.fn()}
      />,
    );
    expect(screen.getByText("fixing the bug")).toBeTruthy();
    expect(screen.queryByText("Claude Code · my-project")).toBeNull();
    expect(screen.queryByText("claude -p 'fix bug'")).toBeNull();
  });

  it("shows session.name when nameLocked even with lastTitle present", () => {
    render(
      <SessionRow
        session={makeSession({
          name: "my custom session",
          nameLocked: true,
          command: "claude",
          lastTitle: "ignored osc title",
        })}
        onOpen={vi.fn()}
        onEnd={vi.fn()}
      />,
    );
    expect(screen.getByText("my custom session")).toBeTruthy();
    expect(screen.queryByText("ignored osc title")).toBeNull();
  });

  it("shows monospace class for command fallback, not for lastTitle", () => {
    const { container: cmdContainer } = render(
      <SessionRow
        session={makeSession({ command: "npm test", lastTitle: null })}
        onOpen={vi.fn()}
        onEnd={vi.fn()}
      />,
    );
    expect(cmdContainer.querySelector(".session-name.mono")).toBeTruthy();

    const { container: oscContainer } = render(
      <SessionRow
        session={makeSession({ command: "npm test", lastTitle: "running tests" })}
        onOpen={vi.fn()}
        onEnd={vi.fn()}
      />,
    );
    expect(oscContainer.querySelector(".session-name.mono")).toBeNull();
  });
});
