// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { GitIdentityFields } from "./GitIdentityFields.js";
import { api } from "../api/index.js";

vi.mock("../api/index.js", () => ({
  api: { getGitIdentityDefault: vi.fn() },
}));

const mockDefault = vi.mocked(api.getGitIdentityDefault);

describe("GitIdentityFields", () => {
  beforeEach(() => {
    mockDefault.mockReset();
  });

  it("reports edits with both halves and commits on blur", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <GitIdentityFields
        value={{ name: "Ada", email: "" }}
        onChange={onChange}
        onCommit={onCommit}
      />,
    );
    const email = screen.getByLabelText("Git author email");
    fireEvent.change(email, { target: { value: "ada@example.com" } });
    expect(onChange).toHaveBeenCalledWith({ name: "Ada", email: "ada@example.com" });
    fireEvent.blur(screen.getByLabelText("Git author name"));
    expect(onCommit).toHaveBeenCalledWith({ name: "Ada", email: "" });
  });

  it("prefills from the server's git config", async () => {
    mockDefault.mockResolvedValue({ name: "Server", email: "server@example.com" });
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <GitIdentityFields value={{ name: "", email: "" }} onChange={onChange} onCommit={onCommit} />,
    );
    fireEvent.click(screen.getByText("Use this server's git config"));
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ name: "Server", email: "server@example.com" }),
    );
    expect(onCommit).toHaveBeenCalledWith({ name: "Server", email: "server@example.com" });
  });

  it("says so when the server has no global identity, or the request fails", async () => {
    mockDefault.mockResolvedValueOnce({ name: "", email: "" });
    const onChange = vi.fn();
    render(<GitIdentityFields value={{ name: "", email: "" }} onChange={onChange} />);
    fireEvent.click(screen.getByText("Use this server's git config"));
    await screen.findByText("No global git identity is set on this server.");
    expect(onChange).not.toHaveBeenCalled();

    mockDefault.mockRejectedValueOnce(new Error("boom"));
    fireEvent.click(screen.getByText("Use this server's git config"));
    await screen.findByText("No global git identity is set on this server.");
  });
});
