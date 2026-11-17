// @vitest-environment jsdom
// The host facet's state and render: persisted with the other filters, hidden on a
// local-only install, and a saved host that has since vanished matches nothing until
// the user resets filters.
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, renderHook, act } from "@testing-library/react";
import { makeHost, makeTask } from "../test/fixtures.js";
import { STORAGE_KEYS } from "../lib/persistedState.js";
import { TaskFacetsPanel } from "./TaskFacetsPanel.js";
import { NO_HOST } from "./taskFilters.js";
import { useTaskFilters } from "./useTaskFilters.js";

const tasks = [makeTask({ id: 1, sessionId: 10 }), makeTask({ id: 2, sessionId: null })];
const sessions = [{ id: 10, resolvedHostId: "h-mac" }];
const remote = [makeHost({ id: "h-mac", name: "mac-mini" })];

beforeEach(() => localStorage.clear());

describe("host facet", () => {
  it("loads old persisted state without hosts as []", () => {
    localStorage.setItem(STORAGE_KEYS.taskAgentFilter, JSON.stringify(["claude"]));
    const { result } = renderHook(() => useTaskFilters(tasks, [], null, sessions, remote));
    expect(result.current.filters.hosts).toEqual([]);
    expect(result.current.visibleTasks).toHaveLength(2);
  });

  it("persists toggles and filters tasks", () => {
    const { result } = renderHook(() => useTaskFilters(tasks, [], null, sessions, remote));
    act(() => result.current.toggleHost("h-mac"));
    expect(result.current.visibleTasks.map((t) => t.id)).toEqual([1]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.taskHostFilter) ?? "")).toEqual(["h-mac"]);
    act(() => result.current.toggleHost(NO_HOST));
    expect(result.current.visibleTasks.map((t) => t.id)).toEqual([1, 2]);
  });

  it("keeps a vanished host (matching nothing) until filters are reset", () => {
    localStorage.setItem(STORAGE_KEYS.taskHostFilter, JSON.stringify(["gone"]));
    const { result } = renderHook(() => useTaskFilters(tasks, [], null, sessions, remote));
    expect(result.current.filters.hosts).toEqual(["gone"]);
    expect(result.current.visibleTasks).toEqual([]);
    expect(result.current.hostLabel("gone")).toBe("gone (unknown)");
    act(() => result.current.clearFilters());
    expect(result.current.filters.hosts).toEqual([]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.taskHostFilter) ?? "")).toEqual([]);
  });

  it("ignores a saved host filter while no remote host is registered", () => {
    localStorage.setItem(STORAGE_KEYS.taskHostFilter, JSON.stringify(["h-mac"]));
    const { result } = renderHook(() => useTaskFilters(tasks, [], null, sessions, []));
    expect(result.current.filters.hosts).toEqual([]);
    expect(result.current.showHostFacet).toBe(false);
  });

  it("renders the facet only when a remote host exists", () => {
    const view = (hosts: typeof remote) => {
      const { result } = renderHook(() => useTaskFilters(tasks, [], null, sessions, hosts));
      return render(<TaskFacetsPanel api={result.current} projects={[]} />);
    };
    const withRemote = view(remote);
    expect(screen.getByText("Host")).toBeTruthy();
    expect(screen.getByText("mac-mini")).toBeTruthy();
    expect(screen.getByText("Not placed yet")).toBeTruthy();
    withRemote.unmount();
    view([]);
    expect(screen.queryByText("Host")).toBeNull();
  });
});
