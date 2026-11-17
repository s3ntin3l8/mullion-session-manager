// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { CreateProjectModal } from "./CreateProjectModal.js";
import { api } from "./api/index.js";
import type * as ApiModule from "./api/index.js";

vi.mock("./api/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listProjectActions: vi.fn(),
      getPlacementPreview: vi.fn(),
      previewPlacement: vi.fn(),
      getHostSuggestions: vi.fn(),
      listProjects: vi.fn(),
    },
  };
});

beforeEach(() => {
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

function stubPointer(coarse: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: coarse && query === "(pointer: coarse)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

// #3287 — on a touch device Add project opens without focusing a text field,
// so the on-screen keyboard stays down and the view opens at its top.
describe("CreateProjectModal — initial focus by pointer type (#3287)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const pathField = () => screen.getByPlaceholderText("~/code/my-project");

  it("a coarse pointer leaves the path field alone and focuses the close button", () => {
    stubPointer(true);
    render(<CreateProjectModal onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(pathField()).not.toHaveFocus();
    expect(screen.getByRole("button", { name: "Close dialog" })).toHaveFocus();
  });

  it("a fine pointer focuses the path field, as before", () => {
    stubPointer(false);
    render(<CreateProjectModal onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(pathField()).toHaveFocus();
  });

  it("embedded under a coarse pointer, Back takes focus rather than the path field", () => {
    stubPointer(true);
    render(<CreateProjectModal surface="embedded" onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(pathField()).not.toHaveFocus();
    expect(screen.getByRole("button", { name: "Back" })).toHaveFocus();
  });

  it("Edit project still focuses the path field under a coarse pointer", () => {
    stubPointer(true);
    render(
      <CreateProjectModal
        mode="edit"
        initialName="mullion"
        initialPath="/home/x/mullion"
        projectId={1}
        projectHostId="local"
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    expect(screen.getByDisplayValue("/home/x/mullion")).toHaveFocus();
  });
});
