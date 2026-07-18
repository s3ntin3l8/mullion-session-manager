// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateProjectModal } from "./CreateProjectModal.js";

// Focused on the issue #28 phase 7 "use detected port" suggestion — the
// field's own pre-fill/edit/clear behavior predates this and isn't
// re-tested here.
describe("CreateProjectModal — detected dev-server port suggestion (issue #28 phase 7)", () => {
  it("shows a suggestion when a detected port differs from the current field value", () => {
    render(
      <CreateProjectModal
        mode="edit"
        initialName="tessera"
        initialPath="/home/x/tessera"
        initialDevServerUrl={null}
        detectedDevServerUrl="5173"
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
        initialName="tessera"
        initialPath="/home/x/tessera"
        initialDevServerUrl={null}
        detectedDevServerUrl="5173"
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
        initialName="tessera"
        initialPath="/home/x/tessera"
        initialDevServerUrl="3000"
        detectedDevServerUrl="5173"
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
        initialName="tessera"
        initialPath="/home/x/tessera"
        initialDevServerUrl={null}
        detectedDevServerUrl={null}
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
        initialName="tessera"
        initialPath="/home/x/tessera"
        initialDevServerUrl="5173"
        detectedDevServerUrl="5173"
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
        detectedDevServerUrl="5173"
        onClose={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.queryByText(/dev server/i)).not.toBeInTheDocument();
  });
});
