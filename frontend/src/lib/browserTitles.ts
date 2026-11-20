// The Browser pane's titles (#3371, decision 5 of
// docs/design/one-browser-pane/note.md): one pane named "Browser", with its
// mode after a middle dot. Kept out of BrowserPaneHost.tsx so the eager
// openers in panelUtils.ts and usePanelOpener.ts can name a new pane the same
// way without pulling the lazy browser chunk into the main bundle.

export type BrowserMode = "preview" | "agent";

export const BROWSER_PREVIEW_TITLE = "Browser · Preview";
const AGENT_TITLE = "Browser · Agent's browser";

export function browserPreviewTitle(target?: string | null): string {
  return target ? `${BROWSER_PREVIEW_TITLE}: ${target}` : BROWSER_PREVIEW_TITLE;
}

export function browserAgentTitle(sessionTitle?: string | null): string {
  return sessionTitle ? `${AGENT_TITLE}: ${sessionTitle}` : AGENT_TITLE;
}

// What a preview pane's title names, read back from the title it was opened
// or saved with. A saved layout carries the titles from before #3371
// ("Preview: <project>", "Preview · <branch>", "Preview", or a saved URL's
// bare label), so all of those are understood, and so is the current form.
export function previewTargetFromTitle(title: string | undefined): string {
  const t = (title ?? "").trim();
  for (const prefix of [`${BROWSER_PREVIEW_TITLE}: `, "Preview: ", "Preview · "]) {
    if (t.startsWith(prefix)) return t.slice(prefix.length).trim();
  }
  if (t === BROWSER_PREVIEW_TITLE || t === "Preview") return "";
  // A title in the agent's form names a session, not a preview target.
  if (t.startsWith(AGENT_TITLE) || t.startsWith("Agent Browser")) return "";
  return t;
}
