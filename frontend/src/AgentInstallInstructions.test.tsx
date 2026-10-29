// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentInstallInstructions } from "./AgentInstallInstructions.js";

const base = {
  onClose: vi.fn(),
  token: "tok-123",
  hostName: "win-pc",
  primaryUrl: "http://dev-01:3100",
};

describe("AgentInstallInstructions", () => {
  it("shows the token and both install commands for a new agent", () => {
    render(<AgentInstallInstructions {...base} kind="install" />);
    expect(screen.getByText("Connect win-pc")).toBeInTheDocument();
    expect(screen.getAllByText(/tok-123/).length).toBeGreaterThan(0);
    expect(screen.getByText(/mullion-install\.ps1/)).toBeInTheDocument();
    expect(screen.getByText(/mullion-install\.sh --role agent/)).toBeInTheDocument();
  });

  it("shows only the .env change for a rotated token", () => {
    render(<AgentInstallInstructions {...base} kind="rotate" />);
    expect(screen.getByText("New token for win-pc")).toBeInTheDocument();
    expect(screen.getByText(/MULLION_ENROLLMENT_TOKEN=tok-123/)).toBeInTheDocument();
    expect(screen.queryByText(/mullion-install\.ps1/)).not.toBeInTheDocument();
  });

  it("copies a block to the clipboard", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(<AgentInstallInstructions {...base} kind="install" />);
    await user.click(screen.getByRole("button", { name: "Copy Token" }));
    expect(writeText).toHaveBeenCalledWith("tok-123");
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });
});
