import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/index.js";
import { useDashboardStore } from "./index.js";
import { EMPTY_SCAFFOLD_DRAFT } from "./slices/scaffold.js";

describe("scaffold slice (#2478)", () => {
  beforeEach(() => {
    useDashboardStore.setState({ scaffoldDrafts: {} });
  });

  it("creates a draft from defaults and merges later patches", () => {
    const { patchScaffoldDraft } = useDashboardStore.getState();
    patchScaffoldDraft(1, { slug: "demo" });
    patchScaffoldDraft(1, { includeDockConfig: true });
    expect(useDashboardStore.getState().scaffoldDrafts[1]).toEqual({
      ...EMPTY_SCAFFOLD_DRAFT,
      slug: "demo",
      includeDockConfig: true,
    });
  });

  it("keeps drafts per project and clears one without touching the other", () => {
    const { patchScaffoldDraft, clearScaffoldDraft } = useDashboardStore.getState();
    patchScaffoldDraft(1, { slug: "a" });
    patchScaffoldDraft(2, { slug: "b" });
    clearScaffoldDraft(1);
    expect(useDashboardStore.getState().scaffoldDrafts[1]).toBeUndefined();
    expect(useDashboardStore.getState().scaffoldDrafts[2]?.slug).toBe("b");
    // Clearing an absent entry is a no-op.
    const before = useDashboardStore.getState().scaffoldDrafts;
    clearScaffoldDraft(99);
    expect(useDashboardStore.getState().scaffoldDrafts).toBe(before);
  });

  it("drops a project's draft when the project is deleted", async () => {
    vi.spyOn(api, "deleteProject").mockResolvedValue(undefined as never);
    useDashboardStore.setState({
      refreshProjects: vi.fn().mockResolvedValue(undefined),
      refreshSessions: vi.fn().mockResolvedValue(undefined),
    });
    useDashboardStore.getState().patchScaffoldDraft(7, { slug: "gone" });
    await useDashboardStore.getState().deleteProject(7);
    expect(useDashboardStore.getState().scaffoldDrafts[7]).toBeUndefined();
  });
});
