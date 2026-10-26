// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { GitHubPrDetailThread } from "../api/types.js";
import { usePrThreadWrites } from "./usePrThreadWrites.js";

const at = "2026-10-26T10:00:00Z";
const reply = { author: "me", bodyHtml: "<p>ok</p>", createdAt: at, htmlUrl: "u" };
const thread = (comments: GitHubPrDetailThread["comments"]): GitHubPrDetailThread => ({
  id: "T1",
  isResolved: false,
  isOutdated: false,
  path: "a.ts",
  line: 1,
  comments,
});

afterEach(() => vi.unstubAllGlobals());

describe("usePrThreadWrites", () => {
  it("keeps overlaying a same-second reply until the server has both", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(reply), { status: 200 }))),
    );
    const refresh = vi.fn();
    const { result } = renderHook(() => usePrThreadWrites(1, 7, refresh));
    await act(() => result.current.reply("T1", "ok"));
    await act(() => result.current.reply("T1", "ok"));
    expect(refresh).toHaveBeenCalledTimes(2);

    const { author, bodyHtml, createdAt } = reply;
    const server = { author, bodyHtml, createdAt };
    expect(result.current.patch([thread([])])[0].comments).toHaveLength(2);
    expect(result.current.patch([thread([server])])[0].comments).toHaveLength(2);
    const both = [thread([server, server])];
    expect(result.current.patch(both)[0]).toBe(both[0]);
  });
});
