// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { IDockviewPanelProps } from "dockview-react";
import { components } from "./registry.js";
import { useDashboardStore } from "../store/index.js";

const RETIRED = [
  "project-hub",
  "agent-rules",
  "project-briefing",
  "project-setup",
  "dock-config",
  "skills",
] as const;

function props(params: { projectId?: number }, close = vi.fn()) {
  const api = { id: "panel-1" };
  const containerApi = { getPanel: () => ({ api: { close } }) };
  return { params, api, containerApi } as unknown as IDockviewPanelProps<{ projectId?: number }>;
}

beforeEach(() => {
  useDashboardStore.setState({ projectSettings: null, projectSettingsDirty: false });
});

// #3406 — the Project panel is retired, and so are the five setup panels it
// once replaced. A saved layout naming an unregistered kind makes fromJSON
// wipe the whole layout, so every key stays, rendering the redirect stub.
describe("retired Project panel registration", () => {
  it.each(RETIRED)("keeps %s registered as the redirect stub", (kind) => {
    const Panel = components[kind] as React.ComponentType<
      IDockviewPanelProps<{ projectId?: number }>
    >;
    render(<Panel {...props({ projectId: 4 })} />);
    expect(screen.getByText("Project settings moved to a dialog")).toBeInTheDocument();
  });

  it("the stub's button opens Project settings for its project and closes the panel", async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    const Panel = components["project-hub"] as React.ComponentType<
      IDockviewPanelProps<{ projectId?: number }>
    >;
    render(<Panel {...props({ projectId: 4 }, close)} />);

    await user.click(screen.getByRole("button", { name: "Open Project settings" }));

    expect(useDashboardStore.getState().projectSettings).toMatchObject({
      projectId: 4,
      section: "agent-rules",
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("a stub with no project just closes", async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    const Panel = components.skills as React.ComponentType<
      IDockviewPanelProps<{ projectId?: number }>
    >;
    render(<Panel {...props({}, close)} />);

    await user.click(screen.getByRole("button", { name: "Open Project settings" }));

    expect(useDashboardStore.getState().projectSettings).toBeNull();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
