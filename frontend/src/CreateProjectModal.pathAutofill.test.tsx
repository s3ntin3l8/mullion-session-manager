// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateProjectModal } from "./CreateProjectModal.js";
import { api, ApiError } from "./api/index.js";
import { makeHost } from "./test/fixtures.js";
import type * as ApiModule from "./api/index.js";

vi.mock("./api/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listProjectActions: vi.fn(),
      recheckReleasePlease: vi.fn(),
      getPlacementPreview: vi.fn(),
      previewPlacement: vi.fn(),
      getHostSuggestions: vi.fn(),
      listProjects: vi.fn(),
      getProject: vi.fn(),
      attachHostCheckout: vi.fn(),
    },
  };
});

beforeEach(() => {
  vi.mocked(api.listProjectActions).mockReset();
  vi.mocked(api.getPlacementPreview).mockReset();
  vi.mocked(api.previewPlacement).mockReset();
  vi.mocked(api.getHostSuggestions).mockReset();
  vi.mocked(api.listProjects).mockReset();
  vi.mocked(api.getProject).mockReset();
  // Default answers, so a test that renders the modal without caring about
  // one of these fetches still has a promise to await (the hook calls
  // .then() on whatever the fetcher returns).
  vi.mocked(api.listProjectActions).mockResolvedValue([]);
  vi.mocked(api.getHostSuggestions).mockResolvedValue({ hosts: [] });
  vi.mocked(api.listProjects).mockResolvedValue([]);
  const preview = {
    placement: "auto" as const,
    hostId: "local",
    reason: "the only eligible host",
    considered: [],
    excluded: [],
    fellBack: false,
  };
  vi.mocked(api.getPlacementPreview).mockResolvedValue(preview);
  vi.mocked(api.previewPlacement).mockResolvedValue(preview);
});

// Issue #2901 — the modal opens with the base project folder prefilled (the
// user's `projectRoots[0]`), and the Display name fills the path in from it,
// so nobody has to retype "/home/you/projects/<name>" by hand.
//
// These live in their own file: CreateProjectModal.test.tsx is at its size
// ceiling (scripts/check-max-file-lines.mjs) and may not grow.
describe("CreateProjectModal — the Display name fills the path (issue #2901)", () => {
  const hosts = [
    makeHost({ id: "local", name: "Local", isLocal: true }),
    makeHost({ id: "mac-1", name: "macbook", platform: "darwin" }),
  ];

  // The Display name's placeholder follows the path, so the fields are found
  // by their own label (same .closest()+querySelector precedent
  // CreateProjectModal.test.tsx's fieldSelect helper uses), never by a
  // placeholder that moves.
  function fieldInput(labelText: string): HTMLInputElement {
    return screen
      .getByText(labelText, { selector: ".create-modal-field-label" })
      .closest(".create-modal-field")!
      .querySelector("input")!;
  }

  function fieldSelect(labelText: string): HTMLSelectElement {
    return screen
      .getByText(labelText, { selector: ".create-modal-field-label" })
      .closest(".create-modal-field")!
      .querySelector("select")!;
  }

  function pathField(): HTMLInputElement {
    return screen.getByPlaceholderText("~/code/my-project") as HTMLInputElement;
  }

  it("fills the path with the base folder plus the name, and submits that path", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <CreateProjectModal
        mode="create"
        initialPath="/base"
        onClose={vi.fn()}
        onCreate={onCreate}
      />,
    );

    await user.type(fieldInput("Display name"), "xxx");

    // The path is shown in the field itself — no hidden state the user cannot
    // see or overwrite.
    expect(pathField()).toHaveValue("/base/xxx");
    // The name's placeholder keeps following the path.
    expect(fieldInput("Display name")).toHaveAttribute("placeholder", "xxx");

    await user.click(screen.getByRole("button", { name: "Add project" }));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/base/xxx" }));
  });

  it("slugs the name into the path, and restores the base folder when the name is cleared", async () => {
    const user = userEvent.setup();
    render(
      <CreateProjectModal
        mode="create"
        initialPath="/base"
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const name = fieldInput("Display name");
    await user.type(name, "my project");

    expect(pathField()).toHaveValue("/base/my-project");

    await user.clear(name);

    expect(pathField()).toHaveValue("/base");
  });

  it("drops a trailing slash from the base folder before appending the name", async () => {
    const user = userEvent.setup();
    render(
      <CreateProjectModal
        mode="create"
        initialPath="/base/"
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await user.type(fieldInput("Display name"), "xxx");

    expect(pathField()).toHaveValue("/base/xxx");
  });

  it("leaves the path alone when there is no base folder to fill it in from", async () => {
    const user = userEvent.setup();
    render(
      <CreateProjectModal
        mode="create"
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await user.type(fieldInput("Display name"), "xxx");

    expect(pathField()).toHaveValue("");
  });

  it("leaves a path the user typed alone — the name never touches it again", async () => {
    const user = userEvent.setup();
    render(
      <CreateProjectModal
        mode="create"
        initialPath="/base"
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const path = pathField();
    await user.clear(path);
    await user.type(path, "/mine");

    await user.type(fieldInput("Display name"), "xxx");

    expect(path).toHaveValue("/mine");
  });

  it("clears a stale error and its 'Create folder' offer, exactly as a typed path does", async () => {
    const onCreate = vi
      .fn()
      .mockRejectedValue(
        new ApiError("Directory /base does not exist.", 400, "PROJECT_DIR_MISSING"),
      );
    const user = userEvent.setup();
    render(
      <CreateProjectModal
        mode="create"
        initialPath="/base"
        onClose={vi.fn()}
        onCreate={onCreate}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add project" }));
    await screen.findByRole("button", { name: "Create folder and add project" });

    await user.type(fieldInput("Display name"), "xxx");

    expect(
      screen.queryByRole("button", { name: "Create folder and add project" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Directory /base does not exist.")).not.toBeInTheDocument();
  });

  it("never rewrites the path in edit mode — renaming a project does not move it", async () => {
    const user = userEvent.setup();
    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/base"
        projectId={1}
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await user.type(fieldInput("Display name"), "-2");

    expect(pathField()).toHaveValue("/base");
  });

  it("does not fill the path for a remote host — the base folder is this machine's", async () => {
    const user = userEvent.setup();
    render(
      <CreateProjectModal
        mode="create"
        initialPath="/base"
        hosts={hosts}
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await user.selectOptions(fieldSelect("Host"), "mac-1");
    await user.type(fieldInput("Display name"), "xxx");

    expect(pathField()).toHaveValue("/base");
  });
});
