// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DockviewApi, IDockviewPanel } from "dockview";
import { MobileSessionBar } from "./MobileSessionBar.js";

const renameSession = vi.fn();
let storeState: Record<string, unknown>;

vi.mock("./store/index.js", () => {
  const useDashboardStore = (selector?: (s: unknown) => unknown) =>
    selector ? selector(storeState) : storeState;
  useDashboardStore.getState = () => storeState;
  return { useDashboardStore };
});

// PaneActionsMenu has its own tests; here it only needs to expose onRename.
vi.mock("./PaneActionsMenu.js", () => ({
  PaneActionsMenu: ({ onRename }: { onRename: () => void }) => (
    <button onClick={onRename}>Rename…</button>
  ),
}));

function fakePanel(id: string, title: string, sessionId?: number) {
  return {
    id,
    title,
    params: sessionId === undefined ? {} : { sessionId },
    api: { setActive: vi.fn(), close: vi.fn(), setTitle: vi.fn() },
  } as unknown as IDockviewPanel;
}

let panels: IDockviewPanel[];
let dockviewApi: DockviewApi;

beforeEach(() => {
  renameSession.mockClear();
  storeState = {
    sessions: [
      { id: 1, command: "bash", attention: true, activity: "idle" },
      { id: 2, command: "claude", attention: false, activity: "working" },
    ],
    events: {
      2: [{ seq: 5, kind: "gate_opened", sessionId: 2, key: "k" }],
    },
    lastSeenSeq: {},
    dismissedEventKeys: {},
    theme: "dark",
    renameSession,
  };
  panels = [
    fakePanel("session-1", "shell", 1),
    fakePanel("session-2", "claude", 2),
    fakePanel("git", "Git"),
  ];
  dockviewApi = { maximizeGroup: vi.fn() } as unknown as DockviewApi;
});

function renderBar(activePanelId: string | null = "session-1") {
  return render(
    <MobileSessionBar
      panels={panels}
      activePanelId={activePanelId}
      dockviewApi={dockviewApi}
      onNewSession={vi.fn()}
    />,
  );
}

describe("MobileSessionBar", () => {
  it("colors the dot by attention/activity and shows the active panel", () => {
    renderBar();
    const trigger = screen.getByRole("button", { name: /shell/ });
    const dot = trigger.querySelector(".mobile-session-dot") as HTMLElement;
    expect(dot.style.background).toBe("var(--ring)");
    expect(trigger).toHaveTextContent("1/3");
  });

  it("activates and maximizes the chosen panel", async () => {
    renderBar();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /shell/ }));
    await user.click(screen.getByText("claude"));
    expect(panels[1].api.setActive).toHaveBeenCalled();
    expect(dockviewApi.maximizeGroup).toHaveBeenCalledWith(panels[1]);
  });

  it("closes a panel from the sheet", async () => {
    renderBar();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /shell/ }));
    await user.click(screen.getByLabelText("Close Git"));
    expect(panels[2].api.close).toHaveBeenCalled();
  });

  it("renames the active session via the actions menu", async () => {
    renderBar();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /shell/ }));
    await user.click(screen.getByText("Rename…"));
    const input = screen.getByLabelText("Session name");
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, "renamed{Enter}");
    expect(panels[0].api.setTitle).toHaveBeenCalledWith("renamed");
    expect(renameSession).toHaveBeenCalledWith(1, "renamed");
  });

  it("does not persist a blank rename", async () => {
    renderBar();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /shell/ }));
    await user.click(screen.getByText("Rename…"));
    const input = screen.getByLabelText("Session name");
    await user.clear(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(renameSession).not.toHaveBeenCalled();
  });

  it("cancels an in-progress rename when the active panel changes elsewhere", async () => {
    const { rerender } = renderBar();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /shell/ }));
    await user.click(screen.getByText("Rename…"));
    expect(screen.getByLabelText("Session name")).toBeInTheDocument();
    act(() => {
      rerender(
        <MobileSessionBar
          panels={panels}
          activePanelId="session-2"
          dockviewApi={dockviewApi}
          onNewSession={vi.fn()}
        />,
      );
    });
    expect(screen.queryByLabelText("Session name")).toBeNull();
    expect(renameSession).not.toHaveBeenCalled();
  });
});
