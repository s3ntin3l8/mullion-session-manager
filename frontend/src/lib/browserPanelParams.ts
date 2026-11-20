// What a preview (BrowserPanel) is opened on and writes back: a grid pane's
// dockview params, or the rail Browser view's stored preview (#3372).
export interface BrowserPanelParams {
  projectId?: number;
  kind?: "external";
  url?: string;
  slug?: string;
  /** Issues #2016/#2018 — a pane opened on one branch preview. Kept apart
   * from `slug`, which BrowserPanel's params write-back rewrites from whatever
   * the pane last loaded (and clears while it loads). */
  previewSlug?: string;
  targetName?: string;
  targetRev?: number;
  activeSavedUrlId?: number | null;
  activeSavedUrlLabel?: string | null;
  /** #3373 — the page below a project preview's root to open first (path,
   * query, hash), when ⇄ brought a page over from the agent's browser. */
  previewPath?: string;
}
