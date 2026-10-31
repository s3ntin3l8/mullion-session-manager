// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SetupBadge } from "./SetupBadge.js";
import { TaskSessionSlot } from "../unified-board/TaskSessionSlot.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { makeSession } from "../test/fixtures.js";

// Issue #2245 — the setup-recipe status badge and its log viewer.
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SetupBadge", () => {
  it("renders nothing when no recipe ran", () => {
    const { container } = render(<SetupBadge sessionId={1} status={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ["running", "setup running"],
    ["ok", "setup ok"],
    ["failed", "setup failed"],
    ["timeout", "setup timed out"],
  ] as const)("labels a %s recipe", (status, label) => {
    render(<SetupBadge sessionId={1} status={status} />);
    expect(screen.getByRole("button", { name: new RegExp(label) })).toHaveTextContent(label);
  });

  it("opens the log on click, flags a truncated tail, and closes", async () => {
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve(jsonResponse(200, { content: "npm ERR! boom", truncated: true })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SetupBadge sessionId={7} status="failed" />);
    await user.click(screen.getByRole("button", { name: /setup failed/ }));
    expect(await screen.findByText("npm ERR! boom")).toBeInTheDocument();
    expect(screen.getByText("Showing the end of the log.")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/sessions/7/setup-log");
    await user.click(screen.getByRole("button", { name: /close/i }));
    expect(screen.queryByText("npm ERR! boom")).not.toBeInTheDocument();
  });

  it("explains a missing log (404) and a failed load", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(jsonResponse(404, { message: "nope" })));
    const user = userEvent.setup();
    const { unmount } = render(<SetupBadge sessionId={7} status="running" />);
    await user.click(screen.getByRole("button", { name: /setup running/ }));
    expect(await screen.findByText(/No log yet/)).toBeInTheDocument();
    unmount();

    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    render(<SetupBadge sessionId={8} status="failed" />);
    await user.click(screen.getByRole("button", { name: /setup failed/ }));
    expect(await screen.findByText("Couldn't load the setup log.")).toBeInTheDocument();
  });
});

describe("TaskSessionSlot", () => {
  it("shows the setup badge on the task card's session strip, without opening the session", async () => {
    const onOpenSession = vi.fn();
    const user = userEvent.setup();
    render(
      <TaskSessionSlot
        session={makeSession({ id: 3, setupStatus: "failed" })}
        role="worker"
        theme="dark"
        onOpenSession={onOpenSession}
      />,
    );
    await user.click(screen.getByRole("button", { name: /setup failed/ }));
    expect(onOpenSession).not.toHaveBeenCalled();
  });
});
