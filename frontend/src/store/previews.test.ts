import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/index.js";
import { ApiError } from "../api/client.js";
import { useDashboardStore } from "./index.js";
import { resetPreviewsThrottleForTests } from "./slices/previews.js";
import { previewErrorMessage, targetKey } from "../hooks/useBranchPreview.js";

const PREVIEW = {
  slug: "s",
  kind: "project" as const,
  projectId: 1,
  externalUrl: null,
  createdAt: "",
  branch: "feat",
};

describe("previews slice (#2016)", () => {
  beforeEach(() => {
    resetPreviewsThrottleForTests();
    useDashboardStore.setState({ previews: [], openPreviewRequest: null });
  });
  afterEach(() => vi.restoreAllMocks());

  it("lists previews when enabled, throttled unless forced", async () => {
    vi.spyOn(api, "getServerInfo").mockResolvedValue({ previewsEnabled: true } as never);
    const list = vi.spyOn(api, "listPreviews").mockResolvedValue([PREVIEW]);
    const { refreshPreviews } = useDashboardStore.getState();
    // Concurrent callers share one request.
    await Promise.all([refreshPreviews(), refreshPreviews()]);
    expect(useDashboardStore.getState().previews).toEqual([PREVIEW]);
    expect(list).toHaveBeenCalledTimes(1);
    await refreshPreviews();
    expect(list).toHaveBeenCalledTimes(1);
    await refreshPreviews(true);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("asks nothing when previews are off, and survives a failed list", async () => {
    const info = vi
      .spyOn(api, "getServerInfo")
      .mockResolvedValue({ previewsEnabled: false } as never);
    const list = vi.spyOn(api, "listPreviews").mockRejectedValue(new Error("down"));
    await useDashboardStore.getState().refreshPreviews();
    expect(list).not.toHaveBeenCalled();
    info.mockResolvedValue({ previewsEnabled: true } as never);
    await useDashboardStore.getState().refreshPreviews(true);
    expect(list).toHaveBeenCalled();
    expect(useDashboardStore.getState().previews).toEqual([]);
  });

  it("numbers open requests and only clears the one it was asked to", () => {
    const { requestOpenPreview, clearOpenPreviewRequest } = useDashboardStore.getState();
    requestOpenPreview({ projectId: 1, slug: "a", branch: "x" });
    const first = useDashboardStore.getState().openPreviewRequest!;
    requestOpenPreview({ projectId: 1, slug: "b", branch: null });
    const second = useDashboardStore.getState().openPreviewRequest!;
    expect(second.nonce).toBe(first.nonce + 1);
    clearOpenPreviewRequest(first.nonce);
    expect(useDashboardStore.getState().openPreviewRequest).toMatchObject({ slug: "b" });
    clearOpenPreviewRequest(second.nonce);
    expect(useDashboardStore.getState().openPreviewRequest).toBeNull();
  });
});

describe("previewErrorMessage", () => {
  it("explains each refusal code, previews-off, and anything else", () => {
    expect(previewErrorMessage(new ApiError("x", 409, "remote_unsupported"))).toMatch(
      /remote host/,
    );
    expect(previewErrorMessage(new ApiError("x", 409, "worktree_busy"))).toMatch(/already running/);
    expect(previewErrorMessage(new ApiError("Not Found", 404))).toMatch(/PREVIEW_BASE_HOST/);
    expect(previewErrorMessage(new ApiError("No branch nope", 404, "unknown_branch"))).toMatch(
      /isn't here or on origin/,
    );
    expect(previewErrorMessage(new ApiError("boom", 502, "start_failed"))).toBe("boom");
  });

  it("keys PR and branch targets apart", () => {
    expect(targetKey({ kind: "pr", number: 3, branch: "x" })).toBe("pr:3");
    expect(targetKey({ kind: "branch", branch: "x" })).toBe("branch:x");
  });
});
