// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OpenUrlModal } from "./OpenUrlModal.js";

describe("OpenUrlModal", () => {
  it("does nothing (just refocuses) when submitted blank", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<OpenUrlModal onClose={vi.fn()} onOpen={onOpen} />);

    await user.click(screen.getByRole("button", { name: "Open" }));

    expect(onOpen).not.toHaveBeenCalled();
  });

  it("submits the trimmed URL and closes on success", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<OpenUrlModal onClose={onClose} onOpen={onOpen} />);

    await user.type(screen.getByLabelText("URL"), "  https://example.com  ");
    await user.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("https://example.com"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("submits on Enter", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn().mockResolvedValue(undefined);
    render(<OpenUrlModal onClose={vi.fn()} onOpen={onOpen} />);

    await user.type(screen.getByLabelText("URL"), "https://example.com{Enter}");

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("https://example.com"));
  });

  it("surfaces a rejected open (e.g. url-guard.ts blocking a private URL) as an inline error and keeps the modal open", async () => {
    const user = userEvent.setup();
    const onOpen = vi
      .fn()
      .mockRejectedValue(new Error("url must be a valid, non-private http(s) URL"));
    const onClose = vi.fn();
    render(<OpenUrlModal onClose={onClose} onOpen={onOpen} />);

    await user.type(screen.getByLabelText("URL"), "http://127.0.0.1:5173");
    await user.click(screen.getByRole("button", { name: "Open" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "url must be a valid, non-private http(s) URL",
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
