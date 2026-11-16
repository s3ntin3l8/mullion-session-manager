// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SpaceReportStatus } from "../../api/index.js";
import { SpaceReport } from "./SpaceReport.js";

const GIB = 1024 ** 3;

const report = {
  available: true,
  root: "/home/me",
  scannedBytes: 3 * GIB,
  filesystemUsedBytes: 4 * GIB,
  outsideBytes: 0,
  unreadableEntries: 0,
  state: "ready" as const,
  measuredAt: "2026-09-13T12:00:00.000Z",
  entries: [
    {
      path: "/home/me/.pyenv",
      bytes: GIB,
      isDirectory: true,
      notCovered: "a toolchain you installed; not touched",
    },
    {
      path: "/home/me/.mullion/data/sessions",
      bytes: GIB,
      isDirectory: true,
      coveredBy: "session cleanup",
    },
    { path: "/home/me/misc", bytes: GIB, isDirectory: true },
  ],
} satisfies SpaceReportStatus & { state: "ready"; measuredAt: string };

describe("SpaceReport chips", () => {
  it("shows the cleanable chip for covered entries and the muted hint for the rest", () => {
    render(<SpaceReport probe={report} now={Date.now()} />);
    expect(screen.getByText("cleanable: session cleanup")).toBeInTheDocument();
    const hint = screen.getByText("a toolchain you installed; not touched");
    expect(hint).toHaveClass("space-not-covered");
    expect(screen.getAllByText(/not touched|cleanable:/)).toHaveLength(2);
  });
});
