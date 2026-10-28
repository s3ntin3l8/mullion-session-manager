// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { api } from "../api/index.js";
import type { OrphanRemovalSnapshot, OrphanRemovalStatus } from "../api/index.js";
import { useOrphanRemoval } from "./useOrphanRemoval.js";

afterEach(() => vi.restoreAllMocks());

it("does not lose an accepted removal when an older focus poll finishes late", async () => {
  const idle: OrphanRemovalSnapshot = { job: { state: "idle" }, recoveries: [] };
  const running: OrphanRemovalStatus = {
    id: "one",
    projectId: 1,
    path: "/p/.wt/x",
    state: "running",
    startedAt: new Date().toISOString(),
  };
  let resolvePoll!: (value: OrphanRemovalSnapshot) => void;
  let resolvePost!: (value: OrphanRemovalStatus) => void;
  const slowPoll = new Promise<OrphanRemovalSnapshot>((resolve) => {
    resolvePoll = resolve;
  });
  const slowPost = new Promise<OrphanRemovalStatus>((resolve) => {
    resolvePost = resolve;
  });
  const get = vi
    .spyOn(api, "getOrphanRemoval")
    .mockResolvedValueOnce(idle)
    .mockResolvedValueOnce(idle)
    .mockReturnValueOnce(slowPoll)
    .mockResolvedValue({ job: running, recoveries: [] });
  const post = vi.spyOn(api, "removeOrphanWorktree").mockReturnValue(slowPost);
  const { result } = renderHook(() =>
    useOrphanRemoval(
      () => {},
      () => {},
    ),
  );
  await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
  act(() => {
    void result.current.start(1, "/p/.wt/x");
  });
  await waitFor(() => expect(post).toHaveBeenCalledOnce());
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
  await act(async () => {
    resolvePost(running);
  });
  await waitFor(() => expect(result.current.job.state).toBe("running"));
  await act(async () => {
    resolvePoll(idle);
  });
  expect(result.current.job.state).toBe("running");
});
