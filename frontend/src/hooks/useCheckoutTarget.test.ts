// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useCheckoutTarget } from "./useCheckoutTarget.js";
import { makeProject, makeSession } from "../test/fixtures.js";
import { resetStore } from "../test/resetStore.js";
import { useDashboardStore } from "../store/index.js";

const project = makeProject({ id: 4, cwd: "/work/app" });
const sessions = [
  makeSession({ id: 9, projectId: 4, cwd: "/work/app/.mullion-worktrees/a" }),
  makeSession({ id: 10, projectId: 4, cwd: "/work/app", resolvedHostId: "mac" }),
];

beforeEach(() => resetStore({ projects: [project], sessions, activePanelId: "session-9" }));

describe("useCheckoutTarget", () => {
  it("binds to the focused session, and to a remote one at the project's path", () => {
    const { result } = renderHook(() => useCheckoutTarget(4));
    expect(result.current.checkoutSessionId).toBe(9);
    act(() => useDashboardStore.setState({ activePanelId: "session-10" }));
    expect(result.current.checkoutSessionId).toBe(10);
  });

  it("honours an explicit project-default choice until another session is focused", () => {
    const { result } = renderHook(() => useCheckoutTarget(4));
    act(() => result.current.choice.onChange(true));
    expect(result.current.checkoutSessionId).toBeNull();
    expect(result.current.choice).toMatchObject({ followedSessionId: 9, projectDefault: true });
    act(() => useDashboardStore.setState({ activePanelId: "session-10" }));
    expect(result.current.checkoutSessionId).toBe(10);
    expect(result.current.choice.projectDefault).toBe(false);
  });
});
