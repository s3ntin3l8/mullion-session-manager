import { useEffect } from "react";
import type { DockviewApi } from "dockview-react";
import type { TerminalPaneParams } from "../TerminalPane.js";
import { repaintAllTerminals } from "../terminalRepaintRegistry.js";

// Extracted from App.tsx (issue #2407). The hook is called at the effect's
// original position so its order among App's other effects is unchanged.
// The effect body, dependency array, and any eslint-disable inside it are
// the original text.

export interface UseTerminalRepaintOnPanelAddParams {
  dockviewApi: DockviewApi | null;
}

export function useTerminalRepaintOnPanelAdd({
  dockviewApi,
}: UseTerminalRepaintOnPanelAddParams): void {
  // Issue #107: opening a new panel (dockview's addPanel/floating-group path)
  // corrupts the already-rendered WebGL canvas pixels of every OTHER live
  // terminal — confirmed live: scrolling only heals the rows it repaints,
  // while the static input/status band stays garbled until a full resize
  // forces every row to re-raster. Reproduce that here instead of waiting for
  // the user to resize: one frame after a panel is added, force every other
  // mounted terminal through the same full repaint a resize would trigger.
  // One rAF (not immediate) so this runs after the new panel's own layout/
  // paint has settled, matching how the corruption is actually observed.
  //
  // Deliberately NOT gated on `panel` actually being a terminal: whether the
  // corruption is caused by the new panel's own WebGL context or by dockview's
  // new composited floating-group layer was never conclusively pinned down
  // (see issue #107) — a non-terminal panel (GitHub/browser) could still be
  // the compositing-layer case. Repainting on every panel add is the safe,
  // mechanism-agnostic choice; the extra repaint work when it turns out to be
  // unnecessary is cheap (a texture-atlas clear + a row refresh per terminal).
  //
  // This hook alone doesn't cover every terminal mount, though: it only fires
  // for dockview `addPanel` events, so `Dock.tsx`'s inline `<TerminalPane>`
  // (rendered outside dockview entirely, with no real panel) never triggers
  // it — leaving existing terminals' shared WebGL glyph atlas corrupted with
  // nothing to heal them. `TerminalPane`'s own mount effect now schedules an
  // equivalent sibling repaint on every mount, mount-site-agnostic, so this
  // hook only needs to keep covering the non-terminal-panel case above.
  useEffect(() => {
    if (!dockviewApi) return;
    const disposable = dockviewApi.onDidAddPanel((panel) => {
      const newSessionId = (panel.params as TerminalPaneParams | undefined)?.sessionId;
      requestAnimationFrame(() => repaintAllTerminals(newSessionId));
    });
    return () => disposable.dispose();
  }, [dockviewApi]);
}
