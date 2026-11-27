// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateHostModal } from "./CreateHostModal.js";

describe("CreateHostModal (edit mode)", () => {
  it("shows an inline error instead of silently doing nothing when the name is blank", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<CreateHostModal onClose={vi.fn()} onSave={onSave} initialName="home-server" />);

    await user.clear(screen.getByLabelText("Name"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("A name is required.");
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
    await user.click(screen.getByRole("button", { name: "Save changes" }));

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

  it("edit mode refuses to clear an existing Base URL instead of silently keeping it", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <CreateHostModal
        onClose={vi.fn()}
        onSave={onSave}
        initialName="home-server"
        initialBaseUrl="http://192.168.1.20:4000"
      />,
    );

    await user.clear(screen.getByLabelText(/^Base URL/));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      screen.getByText(/Base URL can't be cleared: this agent has no live machine identity/),
    ).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  // Issue #3091
  it("edit mode saves an emptied Base URL for a host with a machine identity, and says what else to do", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <CreateHostModal
        onClose={vi.fn()}
        onSave={onSave}
        initialName="macbook"
        initialBaseUrl="http://192.168.2.92:3000"
        canClearBaseUrl
      />,
    );

    expect(screen.getByText(/Clear it to make this host outbound-only/)).toBeInTheDocument();
    expect(screen.getByText(/unset MULLION_AGENT_ADVERTISE_URL/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText(/^Base URL/));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith("macbook", "", ""));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("surfaces a rejected save as an inline error and keeps the modal open", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValue(new Error("host name already in use"));
    const onClose = vi.fn();
    render(
      <CreateHostModal
        onClose={onClose}
        onSave={onSave}
        initialName="home-server"
        initialBaseUrl="http://192.168.1.20:4000"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("host name already in use");
    expect(onClose).not.toHaveBeenCalled();
  });
});

// Audit finding 18 — submit could be triggered twice with Enter.
describe("re-entry guard (audit finding 18)", () => {
  it("swallows a second click on the disabled submit button", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    render(
      <CreateHostModal
        onClose={vi.fn()}
        onSave={onSave}
        initialName="home-server"
        initialBaseUrl="http://192.168.1.20:4000"
      />,
    );

    const submit = screen.getByRole("button", { name: "Save changes" });
    await user.click(submit);
    await user.click(submit);

    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("does not submit twice when Enter is pressed twice", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    render(
      <CreateHostModal
        onClose={vi.fn()}
        onSave={onSave}
        initialName="home-server"
        initialBaseUrl="http://192.168.1.20:4000"
      />,
    );

    await user.type(screen.getByLabelText(/^Token/), "secret{Enter}");
    await user.type(screen.getByLabelText(/^Token/), "{Enter}");

    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("allows a second submission after a failed one", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValue(new Error("the server said no"));
    render(
      <CreateHostModal
        onClose={vi.fn()}
        onSave={onSave}
        initialName="home-server"
        initialBaseUrl="http://192.168.1.20:4000"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("the server said no");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
  });
});
