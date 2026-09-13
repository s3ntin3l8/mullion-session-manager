// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api, type SystemStats } from "./api/index.js";
import { ResourceAlertBanner } from "./ResourceAlertBanner.js";

function stats(severity: "normal" | "warning" | "critical"): SystemStats {
  return {
    sampledAt: new Date().toISOString(),
    cpu: { logicalCores: 4, loadAverage1m: 1 },
    memory: { totalBytes: 100, freeBytes: 50 },
    filesystems: [
      {
        labels: ["Mullion data"],
        paths: ["/data"],
        available: true,
        totalBytes: 100,
        freeBytes: 10,
        freePercent: 10,
        severity,
      },
    ],
  };
}

describe("resource alert banner", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("navigates to Server info and persists warning dismissal", async () => {
    vi.spyOn(api, "getSystemStats").mockResolvedValue(stats("warning"));
    const open = vi.fn();
    render(<ResourceAlertBanner onOpenServer={open} />);
    await userEvent.click(await screen.findByText(/Low disk space/));
    expect(open).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByTitle("Dismiss for 24 hours"));
    expect(screen.queryByText(/Low disk space/)).not.toBeInTheDocument();
    expect(localStorage.getItem("mullion:storage-warning-dismissed-at")).not.toBeNull();
  });

  it("critical escalation overrides an existing warning dismissal", async () => {
    localStorage.setItem("mullion:storage-warning-dismissed-at", String(Date.now()));
    vi.spyOn(api, "getSystemStats").mockResolvedValue(stats("critical"));
    render(<ResourceAlertBanner onOpenServer={vi.fn()} />);
    expect(await screen.findByText(/Critical disk space/)).toBeInTheDocument();
    expect(screen.queryByTitle("Dismiss for 24 hours")).not.toBeInTheDocument();
  });

  it("polls again after 60 seconds and clears after recovery", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "getSystemStats")
      .mockResolvedValueOnce(stats("warning"))
      .mockResolvedValueOnce(stats("normal"));
    render(<ResourceAlertBanner onOpenServer={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(/Low disk space/)).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.queryByText(/Low disk space/)).not.toBeInTheDocument();
  });
});
