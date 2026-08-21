import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { DockviewApi } from "dockview-react";
import type { DockviewGroupPanel } from "dockview";
import {
  applyLayoutPresentation,
  isTiledGroup,
  snapshotTiledGroupWidths,
  restoreTiledGroupWidths,
} from "../panelUtils.js";
import {
  PHONE_BREAKPOINT_QUERY,
  DESKTOP_BREAKPOINT_QUERY,
  resolveLayoutTier,
} from "../lib/layoutTier.js";
import type { LayoutTier } from "../lib/layoutTier.js";
import type { LayoutMode } from "../api/index.js";

export interface UseLayoutPresentationParams {
  dockviewApi: DockviewApi | null;
  // The user's configured override ("auto" by default) — resolveLayoutTier
  // reads live window width itself when this is "auto", so this hook only
  // needs to re-run when the setting value itself changes, not on a timer.
  layoutMode: LayoutMode;
  // App.tsx owns the resolved tier itself (a bare `useState`, not returned
  // from this hook) rather than this hook owning it and returning the value
  // — that's forced, not stylistic: the tier is also read at this
  // component's `useWorkspacePersistence(...)` call, which sits EARLIER in
  // the render body than this hook's own call (see App.tsx's comment at
  // that call site). Returning it from here would require calling this hook
  // before that one, which would reorder this hook's own effects ahead of
  // the `onDidAddPanel` repaint effect that currently runs between them —
  // exactly the ordering regression this PR series is trying to avoid.
  // Passing the raw setter in (same shape as `useWorkspacePersistence`'s own
  // `setPanelsVersion` param) keeps the tier a single piece of state owned
  // in exactly one place, without constraining call order.
  setLayoutTier: Dispatch<SetStateAction<LayoutTier>>;
}

// Extracted from App.tsx (PR 34b of the hook-extraction series; generalized
// from phone-only `useMobileLayout` to the tri-state tier in the tablet tier
// plan, PR 4) — the two effects that keep dockview's presentation in sync
// with the resolved layout tier. Effect ordering here is load-bearing:
// App.tsx calls this hook at the exact same position these two effects
// previously occupied (right after the issue #107 `onDidAddPanel` repaint
// effect, right before the mobile-pane-bar rename-focus effect), so their
// execution order relative to every other effect in App.tsx — in
// particular, running AFTER `useWorkspacePersistence`'s own restore effect
// on the commit where `dockviewApi` first becomes non-null — is unchanged.
// See that hook's own header comment, and the `setLayoutTier` param comment
// above, for why that ordering matters: the restore effect applies
// `applyLayoutPresentation` with whatever tier state already was (still
// "desktop", the useState default, on first mount), and this hook's
// breakpoint effect must run AFTER it to correct that — running before
// would have the restore effect's own `clear()+fromJSON()` undo it.
export function useLayoutPresentation({
  dockviewApi,
  layoutMode,
  setLayoutTier,
}: UseLayoutPresentationParams): void {
  // Breakpoint detection — listens on both the phone and desktop boundary
  // queries (not just phone's) since tablet sits between them: a crossing
  // on EITHER boundary can flip the resolved tier. Skipped entirely once
  // layoutMode is an explicit override — its resolved tier can only change
  // via its own value (already a dependency), not via window width; see
  // lib/layoutTier.ts's useLayoutTier for the same guard. Issue #85:
  // applyLayoutPresentation (not a bare exitMaximizedGroup) so this is
  // symmetric — entering phone now maximizes too, not just leaving it.
  // onChange() already runs immediately on mount, and this effect re-runs
  // when dockviewApi transitions from null to non-null, so "first mount
  // while already phone/tablet" is covered without a separate call.
  // Pane-skew fix (see snapshotTiledGroupWidths/restoreTiledGroupWidths's own
  // header comment in panelUtils.ts for the dockview-internal mechanism this
  // works around) — a ref, not state: it needs to survive across renders
  // without itself triggering one, and its identity is never read by JSX.
  // `prevTierRef` starts `null` (rather than "desktop", the tier's own
  // default) specifically so the very first `onChange()` call on mount —
  // which can land on "phone" if the app is opened at phone width — is never
  // treated as an entering-phone TRANSITION and doesn't snapshot a layout
  // that was never actually tablet/desktop to begin with.
  const prevTierRef = useRef<LayoutTier | null>(null);
  const widthSnapshotRef = useRef<Map<string, number> | null>(null);
  // Holds the pending restore rAF's id so effect cleanup (below) can cancel
  // it — without this, an unmount (or a dockviewApi/layoutMode change that
  // re-runs this effect) between scheduling and firing left the callback to
  // run anyway against a `dockviewApi` that could by then be disposed. The
  // callback's own try/catch already stops that from crashing the app, but
  // there's no reason to let it fire pointlessly instead of just cancelling
  // it — restoreTiledGroupWidths would no-op against a torn-down api regardless.
  const restoreRafRef = useRef<number | null>(null);

  useEffect(() => {
    const onChange = () => {
      const tier = resolveLayoutTier(layoutMode);
      const prevTier = prevTierRef.current;
      prevTierRef.current = tier;
      setLayoutTier(tier);
      if (!dockviewApi) return;
      try {
        if (prevTier !== null && prevTier !== "phone" && tier === "phone") {
          widthSnapshotRef.current = snapshotTiledGroupWidths(dockviewApi);
        }
        applyLayoutPresentation(dockviewApi, tier);
        if (prevTier === "phone" && tier !== "phone" && widthSnapshotRef.current) {
          const snapshot = widthSnapshotRef.current;
          widthSnapshotRef.current = null;
          // Deferred a frame — dockview's own ResizeObserver-driven relayout
          // to the post-fold width hasn't run yet at this point (that's the
          // same ordering gap that causes the skew in the first place), so
          // restoring immediately would apply these proportions against the
          // still-stale width. One rAF is enough: watchElementResize's own
          // relayout is also rAF-scheduled, so by the next frame the grid is
          // already at its real width and this only needs to redistribute,
          // not wait for a second resize.
          const api = dockviewApi;
          if (restoreRafRef.current !== null) cancelAnimationFrame(restoreRafRef.current);
          restoreRafRef.current = requestAnimationFrame(() => {
            restoreRafRef.current = null;
            try {
              restoreTiledGroupWidths(api, snapshot);
            } catch (err) {
              console.error("[useLayoutPresentation] restoreTiledGroupWidths failed", err);
            }
          });
        }
      } catch (err) {
        // Independent code review — applyLayoutPresentation's own comment
        // documents the specific dockview crash this used to be exposed to
        // (a floating active panel) and that path is now fixed, but this
        // catch is belt-and-suspenders against any future one: without it,
        // a throw here left the UI stuck mid-transition (the tier already
        // committed via setLayoutTier above, but no maximize/header-hide
        // ever applied), with no way to retry short of a full reload.
        console.error("[useLayoutPresentation] applyLayoutPresentation failed", err);
      }
    };
    onChange();
    // The pending-rAF cancellation below must run regardless of layoutMode
    // — onChange() just above can schedule one even in an explicit-override
    // mode, so this can't be folded into the `layoutMode !== "auto"` early
    // return the width-boundary-listener setup below still needs.
    if (layoutMode !== "auto") {
      return () => {
        if (restoreRafRef.current !== null) cancelAnimationFrame(restoreRafRef.current);
      };
    }
    const phone = window.matchMedia(PHONE_BREAKPOINT_QUERY);
    const desktop = window.matchMedia(DESKTOP_BREAKPOINT_QUERY);
    phone.addEventListener("change", onChange);
    desktop.addEventListener("change", onChange);
    return () => {
      if (restoreRafRef.current !== null) cancelAnimationFrame(restoreRafRef.current);
      phone.removeEventListener("change", onChange);
      desktop.removeEventListener("change", onChange);
    };
  }, [dockviewApi, layoutMode, setLayoutTier]);

  // Mobile UI/UX overhaul, item A.2 — applyLayoutPresentation (above) syncs
  // every group's header.hidden on restore and on breakpoint change, but a
  // group created and maximized *between* those two moments (e.g. opening a
  // session's timeline or Agent Browser panel on phone — panelUtils.ts's
  // openTimelinePanel/openBrowserPanePanel/openTaskDetailPanel, or the ~14
  // inline `if (layout.tier === "phone") dockviewApi.maximizeGroup(...)`
  // call sites further down App.tsx) would otherwise show its header
  // un-hidden until the next breakpoint change. Every one of those calls
  // `maximizeGroup`, which fires this event — subscribing here once covers
  // all of them (current and future) without editing each call site
  // individually. Also covers `onDidAddGroup` (Hermes review, PR #613): a
  // group created WITHOUT an intervening maximizeGroup — a drag-split, or a
  // future programmatic `addGroup()` — would otherwise render dockview's own
  // tab strip un-hidden until the next breakpoint change, reintroducing this
  // PR's own "doubled switcher" bug for that one group.
  useEffect(() => {
    if (!dockviewApi) return;
    const hideIfPhone = (group: DockviewGroupPanel) => {
      group.header.hidden = resolveLayoutTier(layoutMode) === "phone";
    };
    // onDidMaximizedGroupChange's own `group` is always tiled by
    // construction (a floating group can't be grid-maximized — dockview
    // would throw first, see applyLayoutPresentation's own comment), so it
    // needs no filter. onDidAddGroup fires for a newly created FLOATING
    // group too (independent code review) — e.g. a panel opened via
    // desktopPositioning's `{floating: ...}` branch — and hiding a floating
    // group's header removes its only drag handle and close button, so
    // that one path does need the same isTiledGroup check
    // applyLayoutPresentation uses.
    const maximizedSub = dockviewApi.onDidMaximizedGroupChange(({ group }) => hideIfPhone(group));
    const addedSub = dockviewApi.onDidAddGroup((group) => {
      if (isTiledGroup(group)) hideIfPhone(group);
    });
    return () => {
      maximizedSub.dispose();
      addedSub.dispose();
    };
  }, [dockviewApi, layoutMode]);
}
