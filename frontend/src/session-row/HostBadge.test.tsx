// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { HostBadge } from "./HostBadge.js";
import type { Host } from "../api/index.js";

// Issue #1727 / roadmap 8.13 — the per-session host badge.
//
// The badge answers "which machine is this session on?" and it must be
// QUIET: a local session says nothing at all, because a local session is
// the overwhelmingly common case and a badge on every row would be noise.

function host(over: Partial<Host> = {}): Host {
  return {
    id: "mgmt",
    name: "mgmt",
    baseUrl: "http://192.168.2.157:3101",
    isLocal: false,
    hasToken: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    health: "online",
    lastSeenAt: null,
    lastCheckedAt: null,
    ...over,
  };
}

describe("HostBadge", () => {
  it("renders nothing for a local session", () => {
    const { container } = render(
      <HostBadge hostId="local" hosts={[host({ id: "local", name: "This machine" })]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the session has no host of its own and its project is local", () => {
    // NULL means "inherit the project's host" (the column's own meaning).
    const { container } = render(
      <HostBadge hostId={null} projectHostId="local" hosts={[host({ id: "local" })]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("names the host a session runs on", () => {
    render(<HostBadge hostId="mgmt" hosts={[host()]} />);
    expect(screen.getByText("mgmt")).toBeInTheDocument();
  });

  it("falls back to the project's host when the session has none of its own", () => {
    render(<HostBadge hostId={null} projectHostId="mgmt" hosts={[host()]} />);
    expect(screen.getByText("mgmt")).toBeInTheDocument();
  });

  it("says which host it is in the tooltip", () => {
    render(<HostBadge hostId="mgmt" hosts={[host({ name: "the mac mini" })]} />);
    expect(screen.getByTitle("Runs on host: the mac mini")).toBeInTheDocument();
  });

  it("renders nothing for a host that is not in the list", () => {
    // A session on a host this install does not know about (a stale row,
    // or a host removed while the session row survived) says nothing rather
    // than showing a bare id.
    const { container } = render(<HostBadge hostId="gone" hosts={[host()]} />);
    expect(container.firstChild).toBeNull();
  });
});
