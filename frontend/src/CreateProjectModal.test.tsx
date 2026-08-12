// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateProjectModal } from "./CreateProjectModal.js";
import { api, ApiError } from "./api/index.js";
import type { Launcher } from "./api/index.js";
import type * as ApiModule from "./api/index.js";

vi.mock("./api/index.js", async (importOriginal) => {
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

    expect(onCreate).toHaveBeenCalledWith({
      name: "mullion",
      cwd: "/home/x/mullion",
      hostId: undefined,
      devServerUrl: null,
      defaultAgent: "claude",
      defaultReviewAgent: null,
    });
  });
});

describe("CreateProjectModal — confirm-first directory creation and error handling", () => {
  it("renders the ApiError message on failure and does not call onClose", async () => {
    const onClose = vi.fn();
    const onCreate = vi
      .fn()
      .mockRejectedValue(
        new ApiError("Cannot access /x: permission denied.", 400, "PROJECT_DIR_UNREADABLE"),
      );
    const user = userEvent.setup();
    render(<CreateProjectModal onClose={onClose} onCreate={onCreate} initialPath="/x" />);

    await user.click(screen.getByRole("button", { name: "Add project" }));

    expect(await screen.findByText("Cannot access /x: permission denied.")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Create folder and add project" }),
    ).not.toBeInTheDocument();
  });

  it("offers Create folder for PROJECT_DIR_MISSING", async () => {
    const onCreate = vi
      .fn()
      .mockRejectedValue(
        new ApiError("Directory /new does not exist.", 400, "PROJECT_DIR_MISSING"),
      );
    const user = userEvent.setup();
    render(<CreateProjectModal onClose={vi.fn()} onCreate={onCreate} initialPath="/new" />);

    await user.click(screen.getByRole("button", { name: "Add project" }));

    expect(
      await screen.findByRole("button", { name: "Create folder and add project" }),
    ).toBeInTheDocument();
  });

  it("does not offer Create folder for PROJECT_PARENT_MISSING — the typo case", async () => {
    const onCreate = vi
      .fn()
      .mockRejectedValue(
        new ApiError("Parent directory /nope does not exist.", 400, "PROJECT_PARENT_MISSING"),
      );
    const user = userEvent.setup();
    render(<CreateProjectModal onClose={vi.fn()} onCreate={onCreate} initialPath="/nope/x" />);

    await user.click(screen.getByRole("button", { name: "Add project" }));

    await screen.findByText("Parent directory /nope does not exist.");
    expect(
      screen.queryByRole("button", { name: "Create folder and add project" }),
    ).not.toBeInTheDocument();
  });

  it("clicking Create folder re-invokes onCreate with createDir: true and closes on success", async () => {
    const onClose = vi.fn();
    const onCreate = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError("Directory /new does not exist.", 400, "PROJECT_DIR_MISSING"),
      )
      .mockResolvedValueOnce({ dirCreated: true, gitInitialized: false });
    const user = userEvent.setup();
    render(<CreateProjectModal onClose={onClose} onCreate={onCreate} initialPath="/new" />);

    await user.click(screen.getByRole("button", { name: "Add project" }));
    await user.click(await screen.findByRole("button", { name: "Create folder and add project" }));

    expect(onCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ createDir: true, gitInit: false }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("forwards gitInit: true only when the checkbox is checked", async () => {
    const onCreate = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError("Directory /new does not exist.", 400, "PROJECT_DIR_MISSING"),
      )
      .mockResolvedValueOnce({ dirCreated: true, gitInitialized: true });
    const user = userEvent.setup();
    render(<CreateProjectModal onClose={vi.fn()} onCreate={onCreate} initialPath="/new" />);

    await user.click(screen.getByRole("button", { name: "Add project" }));
    await user.click(await screen.findByRole("checkbox", { name: /initialize a git repository/i }));
    await user.click(screen.getByRole("button", { name: "Create folder and add project" }));

    expect(onCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ createDir: true, gitInit: true }),
    );
  });

  it("shows a non-blocking warning and does not close when git init fails", async () => {
    const onClose = vi.fn();
    const onCreate = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError("Directory /new does not exist.", 400, "PROJECT_DIR_MISSING"),
      )
      .mockResolvedValueOnce({ dirCreated: true, gitInitialized: false });
    const user = userEvent.setup();
    render(<CreateProjectModal onClose={onClose} onCreate={onCreate} initialPath="/new" />);

    await user.click(screen.getByRole("button", { name: "Add project" }));
    await user.click(await screen.findByRole("checkbox", { name: /initialize a git repository/i }));
    await user.click(screen.getByRole("button", { name: "Create folder and add project" }));

    expect(await screen.findByText(/git init.*failed/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("does not show the git-init-failed warning when the directory already existed (dirCreated: false) — Hermes review, PR #620", async () => {
    // gitInitialized: false here means "never attempted" (the directory was
    // created concurrently between the initial 400 and this retry, so the
    // backend skipped git init entirely) — distinct from "attempted and
    // failed", which only ever happens when dirCreated is also true.
    const onClose = vi.fn();
    const onCreate = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError("Directory /new does not exist.", 400, "PROJECT_DIR_MISSING"),
      )
      .mockResolvedValueOnce({ dirCreated: false, gitInitialized: false });
    const user = userEvent.setup();
    render(<CreateProjectModal onClose={onClose} onCreate={onCreate} initialPath="/new" />);

    await user.click(screen.getByRole("button", { name: "Add project" }));
    await user.click(await screen.findByRole("checkbox", { name: /initialize a git repository/i }));
    await user.click(screen.getByRole("button", { name: "Create folder and add project" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByText(/git init.*failed/i)).not.toBeInTheDocument();
  });

  it("disables the submit button while the request is in flight", async () => {
    let resolveCreate: (
      v: { dirCreated?: boolean; gitInitialized?: boolean } | undefined,
    ) => void = () => {};
    const onCreate = vi.fn(
      () =>
        new Promise<{ dirCreated?: boolean; gitInitialized?: boolean } | undefined>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const user = userEvent.setup();
    render(<CreateProjectModal onClose={vi.fn()} onCreate={onCreate} initialPath="/x" />);

    await user.click(screen.getByRole("button", { name: "Add project" }));

    expect(screen.getByRole("button", { name: "Adding…" })).toBeDisabled();
    resolveCreate(undefined);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Adding…" })).not.toBeInTheDocument(),
    );
  });

  it("editing the path clears the error and hides the affordance", async () => {
    const onCreate = vi
      .fn()
      .mockRejectedValue(
        new ApiError("Directory /new does not exist.", 400, "PROJECT_DIR_MISSING"),
      );
    const user = userEvent.setup();
    render(<CreateProjectModal onClose={vi.fn()} onCreate={onCreate} initialPath="/new" />);

    await user.click(screen.getByRole("button", { name: "Add project" }));
    await screen.findByRole("button", { name: "Create folder and add project" });

    await user.type(screen.getByPlaceholderText("~/code/my-project"), "x");

    expect(
      screen.queryByRole("button", { name: "Create folder and add project" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Directory /new does not exist.")).not.toBeInTheDocument();
  });

  it("calls onClose on a plain successful create (no createDir involved)", async () => {
    const onClose = vi.fn();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<CreateProjectModal onClose={onClose} onCreate={onCreate} initialPath="/x" />);

    await user.click(screen.getByRole("button", { name: "Add project" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("edit mode still submits name/cwd/devServerUrl unchanged (guards the object refactor)", async () => {
    const onClose = vi.fn();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        initialDevServerUrl="3000"
        onClose={onClose}
        onCreate={onCreate}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onCreate).toHaveBeenCalledWith({
      name: "mullion",
      cwd: "/home/x/mullion",
      hostId: undefined,
      devServerUrl: "3000",
      defaultAgent: null,
      defaultReviewAgent: null,
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
