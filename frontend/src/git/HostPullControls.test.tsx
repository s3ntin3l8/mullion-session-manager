// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/index.js";
import type { GitPullResult } from "../api/index.js";
import { useDashboardStore } from "../store/index.js";
import { makeHost, makeProject } from "../test/fixtures.js";
import { HostPullControls } from "./HostPullControls.js";

const project = makeProject({
  id: 42,
  hostId: "local",
  hostCwds: { local: "/primary", box: "/remote/repo", empty: " " },
});

beforeEach(() => {
  useDashboardStore.setState({
    hosts: [makeHost({ id: "box", name: "Build box", health: "online" })],
  });
});
afterEach(() => vi.restoreAllMocks());

describe("extra-host checkout pulls", () => {
  it("uses the explicit host through the real store and shows success", async () => {
    const pull = vi.spyOn(api, "postProjectGitPull").mockResolvedValue({ pulled: true });
    const trigger = useDashboardStore.getState().gitRefreshTrigger;
    render(<HostPullControls project={project} />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Pull on Build box" }));
    await screen.findByText("Build box: Pulled successfully.");
    expect(pull).toHaveBeenCalledWith(42, undefined, "box");
    expect(useDashboardStore.getState().gitRefreshTrigger).toBeGreaterThan(trigger);
  });

  it.each([
    ["offline", false, "Host is offline"],
    ["pending", false, "Host is offline"],
    ["online", true, "Host is drained"],
  ] as const)("disables %s drained=%s with a visible reason", (health, drained, reason) => {
    useDashboardStore.setState({
      hosts: [makeHost({ id: "box", name: "Build box", health, drained })],
    });
    const pull = vi.spyOn(api, "postProjectGitPull");
    render(<HostPullControls project={project} />);
    const button = screen.getByRole("button", { name: "Pull on Build box" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", reason);
    expect(screen.getByText(`— ${reason}`)).toBeInTheDocument();
    fireEvent.click(button);
    expect(pull).not.toHaveBeenCalled();
  });

  it("keeps unknown hosts visible but unavailable", () => {
    useDashboardStore.setState({ hosts: [] });
    render(<HostPullControls project={project} />);
    expect(screen.getByRole("button", { name: "Pull on box" })).toBeDisabled();
    expect(screen.getByText("— Host information unavailable")).toBeInTheDocument();
  });

  it("shows both refusal reason and detail", async () => {
    vi.spyOn(api, "postProjectGitPull").mockResolvedValue({
      pulled: false,
      reason: "dirty-tree",
      detail: "staged config.ts",
    });
    render(<HostPullControls project={project} />);
    fireEvent.click(screen.getByRole("button", { name: "Pull on Build box" }));
    const result = await screen.findByRole("status");
    expect(result).toHaveTextContent("uncommitted changes");
    expect(result).toHaveTextContent("staged config.ts");
  });

  it("shows request failures and allows retry", async () => {
    vi.spyOn(api, "postProjectGitPull").mockRejectedValue(new Error("Host disconnected"));
    render(<HostPullControls project={project} />);
    fireEvent.click(screen.getByRole("button", { name: "Pull on Build box" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Host disconnected");
    expect(screen.getByRole("button", { name: "Pull on Build box" })).toBeEnabled();
  });

  it("clears the displayed result when an extra checkout path changes", async () => {
    vi.spyOn(api, "postProjectGitPull").mockResolvedValue({ pulled: true });
    const { rerender } = render(<HostPullControls project={project} />);
    fireEvent.click(screen.getByRole("button", { name: "Pull on Build box" }));
    await screen.findByRole("status");
    rerender(
      <HostPullControls project={{ ...project, hostCwds: { box: "/different/checkout" } }} />,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pull on Build box" })).toHaveAttribute(
      "title",
      "/different/checkout",
    );
  });

  it("guards duplicate requests and hides late results after switching projects", async () => {
    let resolve!: (result: GitPullResult) => void;
    const pull = vi.spyOn(api, "postProjectGitPull").mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const { rerender } = render(<HostPullControls project={project} />);
    fireEvent.click(screen.getByRole("button", { name: "Pull on Build box" }));
    expect(screen.getByRole("button", { name: "Pulling on Build box" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Pulling on Build box" }));
    expect(pull).toHaveBeenCalledTimes(1);
    rerender(<HostPullControls project={{ ...project, id: 43 }} />);
    await act(async () => resolve({ pulled: true }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pull on Build box" })).toBeEnabled(),
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
