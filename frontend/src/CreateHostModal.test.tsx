// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateHostModal } from "./CreateHostModal.js";

// Regression coverage for the Hermes review findings on PR #35 (issue #26,
// phase 4): the blank-fields path used to silently focus the input with no
// visible feedback, and this is the frontend's first component-test file
// (see vitest.config.ts's per-file `@vitest-environment jsdom` directive
// above — the project-wide config stays "node" for the existing pure-logic
// test files).

describe("CreateHostModal", () => {
  it("shows an inline error instead of silently doing nothing when name/baseUrl are blank", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<CreateHostModal onClose={vi.fn()} onSave={onSave} />);

    await user.click(screen.getByRole("button", { name: "Add host" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Name and base URL are both required.",
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it("requires a token in create mode but not in edit mode", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<CreateHostModal onClose={vi.fn()} onSave={onSave} />);

    await user.type(screen.getByLabelText("Name"), "home-server");
    await user.type(screen.getByLabelText(/^Base URL/), "http://192.168.1.20:4000");
    await user.click(screen.getByRole("button", { name: "Add host" }));

    expect(await screen.findByText(/A shared secret token is required/)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("submits trimmed values and closes on success", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<CreateHostModal onClose={onClose} onSave={onSave} />);

    await user.type(screen.getByLabelText("Name"), "  home-server  ");
    await user.type(screen.getByLabelText(/^Base URL/), "  http://192.168.1.20:4000  ");
    await user.type(screen.getByLabelText(/^Token/), "  secret  ");
    await user.click(screen.getByRole("button", { name: "Add host" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith("home-server", "http://192.168.1.20:4000", "secret");
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("edit mode with an existing token doesn't require re-entering one, and hints that blank keeps it", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <CreateHostModal
        onClose={vi.fn()}
        onSave={onSave}
        mode="edit"
        initialName="home-server"
        initialBaseUrl="http://192.168.1.20:4000"
        hasToken
      />,
    );

    expect(screen.getByLabelText(/^Token/)).toHaveAttribute(
      "placeholder",
      "Leave blank to keep the current token",
    );

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith("home-server", "http://192.168.1.20:4000", "");
    });
  });

  it("surfaces a rejected save as an inline error and keeps the modal open", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValue(new Error("host name already in use"));
    const onClose = vi.fn();
    render(<CreateHostModal onClose={onClose} onSave={onSave} />);

    await user.type(screen.getByLabelText("Name"), "home-server");
    await user.type(screen.getByLabelText(/^Base URL/), "http://192.168.1.20:4000");
    await user.type(screen.getByLabelText(/^Token/), "secret");
    await user.click(screen.getByRole("button", { name: "Add host" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("host name already in use");
    expect(onClose).not.toHaveBeenCalled();
  });
});

// Audit finding 18 — "Add host" could be submitted twice with Enter. The
// submit button is disabled while saving, but React has not re-rendered
// yet when the second Enter arrives, so the second submission went
// through and the same host was registered twice.
describe("re-entry guard (audit finding 18)", () => {
  it("does not submit twice when the button is clicked twice", async () => {
    const user = userEvent.setup();
    // A save that never settles, so the second click lands while the
    // first is still in flight.
    const onSave = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    render(<CreateHostModal onClose={vi.fn()} onSave={onSave} />);

    await user.type(screen.getByLabelText("Name"), "home-server");
    await user.type(screen.getByLabelText(/^Base URL/), "http://192.168.1.20:4000");
    await user.type(screen.getByLabelText(/^Token/), "secret");

    const submit = screen.getByRole("button", { name: "Add host" });
    await user.click(submit);
    await user.click(submit);

    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("does not submit twice when Enter is pressed twice", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    render(<CreateHostModal onClose={vi.fn()} onSave={onSave} />);

    await user.type(screen.getByLabelText("Name"), "home-server");
    await user.type(screen.getByLabelText(/^Base URL/), "http://192.168.1.20:4000");
    await user.type(screen.getByLabelText(/^Token/), "secret{Enter}");
    await user.type(screen.getByLabelText(/^Token/), "{Enter}");

    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("allows a second submission after a failed one", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValue(new Error("the server said no"));
    render(<CreateHostModal onClose={vi.fn()} onSave={onSave} />);

    await user.type(screen.getByLabelText("Name"), "home-server");
    await user.type(screen.getByLabelText(/^Base URL/), "http://192.168.1.20:4000");
    await user.type(screen.getByLabelText(/^Token/), "secret");
    await user.click(screen.getByRole("button", { name: "Add host" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("the server said no");
    // The guard released, so a retry is possible.
    await user.click(screen.getByRole("button", { name: "Add host" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
  });
});
