// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateProjectModal } from "./CreateProjectModal.js";
import { api } from "./api.js";
import type { Launcher } from "./api.js";
import type * as ApiModule from "./api.js";

vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: { ...actual.api, listProjectActions: vi.fn() },
  };
});

function makeLauncher(overrides: Partial<Launcher>): Launcher {
  return { id: "agent:claude", title: "claude", command: "claude", kind: "agent", ...overrides };
}

// Both dropdowns share the same detected-launcher options, so a page-wide
// role/label query is ambiguous — scope to the specific field's own <select>
// via its field-label span, same .closest()+querySelector precedent
// Settings.sessions.test.tsx already uses for disambiguating repeated rows.
function fieldSelect(labelText: string): HTMLSelectElement {
  return screen
    .getByText(labelText, { selector: ".create-modal-field-label" })
    .closest(".create-modal-field")!
    .querySelector("select")!;
}

beforeEach(() => {
  vi.mocked(api.listProjectActions).mockReset();
});

// Focused on the issue #28 phase 7 "use detected port" suggestion — the
// field's own pre-fill/edit/clear behavior predates this and isn't
// re-tested here.
describe("CreateProjectModal — detected dev-server port suggestion (issue #28 phase 7)", () => {
  it("shows a suggestion when a detected port differs from the current field value", () => {
    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        initialDevServerUrl={null}
        detectedDevServerPort="5173"
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText(/detected dev server on port 5173/i)).toBeInTheDocument();
  });

  it("clicking the suggestion fills the field and the suggestion then disappears", async () => {
    const user = userEvent.setup();
    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        initialDevServerUrl={null}
        detectedDevServerPort="5173"
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await user.click(screen.getByText(/detected dev server on port 5173/i));

    expect(screen.getByPlaceholderText("5173")).toHaveValue("5173");
    expect(screen.queryByText(/detected dev server on port 5173/i)).not.toBeInTheDocument();
  });

  it("never overwrites an already-set value that differs from the detected one — no auto-apply", () => {
    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        initialDevServerUrl="3000"
        detectedDevServerPort="5173"
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    // The field keeps the user's own value...
    expect(screen.getByPlaceholderText("5173")).toHaveValue("3000");
    // ...and the suggestion is offered, not silently applied.
    expect(screen.getByText(/detected dev server on port 5173/i)).toBeInTheDocument();
  });

  it("shows no suggestion when nothing was detected", () => {
    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        initialDevServerUrl={null}
        detectedDevServerPort={null}
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.queryByText(/detected dev server on port/i)).not.toBeInTheDocument();
  });

  it("shows no suggestion when the detected port already matches the current field value", () => {
    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        initialDevServerUrl="5173"
        detectedDevServerPort="5173"
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.queryByText(/detected dev server on port/i)).not.toBeInTheDocument();
  });

  it("never renders the dev-server field (or a suggestion) in create mode", () => {
    render(
      <CreateProjectModal
        mode="create"
        detectedDevServerPort="5173"
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.queryByText(/dev server/i)).not.toBeInTheDocument();
  });
});

// Hermes review, PR #477 — Default Agent / Default Review Agent dropdowns
// (Phase 6 Task Master, 6.5/#218). Both dropdowns share the same detected
// launchers, so every query below is scoped to one via the fieldSelect
// helper rather than an ambiguous page-wide role query.
describe("CreateProjectModal — Default Agent / Default Review Agent dropdowns", () => {
  it("lists detected agent launchers as options", async () => {
    vi.mocked(api.listProjectActions).mockResolvedValue([
      makeLauncher({ id: "agent:claude", title: "claude" }),
      makeLauncher({ id: "agent:codex", title: "codex" }),
    ]);

    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        projectId={1}
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const select = fieldSelect("Default agent");
    await waitFor(() =>
      expect(within(select).getByRole("option", { name: "claude" })).toBeInTheDocument(),
    );
    expect(within(select).getByRole("option", { name: "codex" })).toBeInTheDocument();
  });

  it("keeps a saved defaultAgent selected even when it's not among the detected launchers", async () => {
    vi.mocked(api.listProjectActions).mockResolvedValue([
      makeLauncher({ id: "agent:codex", title: "codex" }),
    ]);

    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        projectId={1}
        initialDefaultAgent="claude"
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const select = fieldSelect("Default agent");
    await waitFor(() =>
      expect(within(select).getByRole("option", { name: "codex" })).toBeInTheDocument(),
    );

    // The saved value gets its own synthetic option rather than the
    // <select> silently falling back to displaying "Use global default"
    // while state still holds "claude" underneath.
    expect(within(select).getByRole("option", { name: "claude (not detected)" })).toHaveProperty(
      "selected",
      true,
    );
  });

  it("shows a retry hint when the launchers fetch fails, and retries on click", async () => {
    vi.mocked(api.listProjectActions).mockRejectedValueOnce(new Error("network down"));

    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        projectId={1}
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText(/Couldn't load this project's detected agents/)).toBeInTheDocument(),
    );

    vi.mocked(api.listProjectActions).mockResolvedValue([
      makeLauncher({ id: "agent:claude", title: "claude" }),
    ]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(
        screen.queryByText(/Couldn't load this project's detected agents/),
      ).not.toBeInTheDocument(),
    );
    const select = fieldSelect("Default agent");
    expect(within(select).getByRole("option", { name: "claude" })).toBeInTheDocument();
  });

  it("does not fetch launchers in create mode (no projectId yet)", () => {
    render(
      <CreateProjectModal
        mode="create"
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(api.listProjectActions).not.toHaveBeenCalled();
  });

  it("passes defaultAgent/defaultReviewAgent through to onCreate on save", async () => {
    vi.mocked(api.listProjectActions).mockResolvedValue([
      makeLauncher({ id: "agent:claude", title: "claude" }),
    ]);
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        projectId={1}
        onClose={vi.fn()}
        onCreate={onCreate}
      />,
    );

    const select = fieldSelect("Default agent");
    await waitFor(() =>
      expect(within(select).getByRole("option", { name: "claude" })).toBeInTheDocument(),
    );
    await user.selectOptions(select, "claude");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onCreate).toHaveBeenCalledWith(
      "mullion",
      "/home/x/mullion",
      undefined,
      null,
      "claude",
      null,
    );
  });
});
