import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { DockviewApi } from "dockview-react";
import type { DockviewGroupPanel } from "dockview";
import { applyMobilePresentation, isTiledGroup } from "../panelUtils.js";
import { MOBILE_BREAKPOINT_QUERY } from "../panels/registry.js";

export interface UseMobileLayoutParams {
  dockviewApi: DockviewApi | null;
  // App.tsx owns `isMobile` itself (a bare `useState`, not returned from this
  // hook) rather than this hook owning it and returning the value — that's
  // forced, not stylistic: `isMobile` is also read at this component's
  // `useWorkspacePersistence(...)` call, which sits EARLIER in the render
  // body than this hook's own call (see App.tsx's comment at that call site).
  // Returning it from here would require calling this hook before that one,
  // which would reorder this hook's own effects ahead of the `onDidAddPanel`
  // repaint effect that currently runs between them — exactly the ordering
  // regression this PR series is trying to avoid. Passing the raw setter in
  // (same shape as `useWorkspacePersistence`'s own `setPanelsVersion` param)
  // keeps `isMobile` a single piece of state owned in exactly one place,
  // without constraining call order.
  setIsMobile: Dispatch<SetStateAction<boolean>>;
}

// Extracted from App.tsx (PR 34b of the hook-extraction series) — the two
// effects that keep dockview's presentation in sync with the mobile
// breakpoint. Effect ordering here is load-bearing: App.tsx calls this hook
// at the exact same position these two effects previously occupied (right
// after the issue #107 `onDidAddPanel` repaint effect, right before the
// mobile-pane-bar rename-focus effect), so their execution order relative to
// every other effect in App.tsx — in particular, running AFTER
// `useWorkspacePersistence`'s own restore effect on the commit where
// `dockviewApi` first becomes non-null — is unchanged. See that hook's own
// header comment, and the `setIsMobile` param comment above, for why that
// ordering matters: the restore effect applies `applyMobilePresentation`
// with whatever `isMobile` already was (still `false` on first mount), and
// this hook's breakpoint effect must run AFTER it to correct that — running
// before would have the restore effect's own `clear()+fromJSON()` undo it.
export function useMobileLayout({ dockviewApi, setIsMobile }: UseMobileLayoutParams): void {
  // Mobile breakpoint detection — mirrors the design's own matchMedia usage
  // (699px) rather than duplicating the value as a magic number elsewhere.
  // Issue #85: applyMobilePresentation (not a bare exitMaximizedGroup) so
  // this is symmetric — entering mobile now maximizes too, not just leaving
  // it. onChange() already runs immediately on mount, and this effect
  // re-runs when dockviewApi transitions from null to non-null, so "first
  // mount while already mobile" is covered without a separate call.
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_BREAKPOINT_QUERY);
    const onChange = () => {
      setIsMobile(mq.matches);
      if (!dockviewApi) return;
      try {
        applyMobilePresentation(dockviewApi, mq.matches);
      } catch (err) {
        // Independent code review — applyMobilePresentation's own comment
        // documents the specific dockview crash this used to be exposed to
        // (a floating active panel) and that path is now fixed, but this
        // catch is belt-and-suspenders against any future one: without it,
        // a throw here left the UI stuck mid-transition (isMobile already
        // committed via setIsMobile above, but no maximize/header-hide ever
        // applied), with no way to retry short of a full reload.
        console.error("[useMobileLayout] applyMobilePresentation failed", err);
      }
    };
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [dockviewApi, setIsMobile]);

  // Mobile UI/UX overhaul, item A.2 — applyMobilePresentation (above) syncs
  // every group's header.hidden on restore and on breakpoint change, but a
  // group created and maximized *between* those two moments (e.g. opening a
  // session's timeline or Agent Browser panel on mobile — panelUtils.ts's
  // openTimelinePanel/openBrowserPanePanel/openTaskDetailPanel, or the ~14
  // inline `if (isMobile) dockviewApi.maximizeGroup(...)` call sites further
  // down App.tsx) would otherwise show its header un-hidden until the next
  // breakpoint change. Every one of those calls `maximizeGroup`, which fires
  // this event — subscribing here once covers all of them (current and
  // future) without editing each call site individually. Also covers
  // `onDidAddGroup` (Hermes review, PR #613): a group created WITHOUT an
  // intervening maximizeGroup — a drag-split, or a future programmatic
  // `addGroup()` — would otherwise render dockview's own tab strip un-hidden
  // until the next breakpoint change, reintroducing this PR's own "doubled
  // switcher" bug for that one group.
  useEffect(() => {
    if (!dockviewApi) return;
    const hideIfMobile = (group: DockviewGroupPanel) => {
      group.header.hidden = window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches;
    };
    // onDidMaximizedGroupChange's own `group` is always tiled by
    // construction (a floating group can't be grid-maximized — dockview
    // would throw first, see applyMobilePresentation's own comment), so it
    // needs no filter. onDidAddGroup fires for a newly created FLOATING
    // group too (independent code review) — e.g. a panel opened via
    // desktopPositioning's `{floating: ...}` branch — and hiding a floating
    // group's header removes its only drag handle and close button, so
    // that one path does need the same isTiledGroup check
    // applyMobilePresentation uses.
    const maximizedSub = dockviewApi.onDidMaximizedGroupChange(({ group }) => hideIfMobile(group));
    const addedSub = dockviewApi.onDidAddGroup((group) => {
      if (isTiledGroup(group)) hideIfMobile(group);
    });
    return () => {
      maximizedSub.dispose();
      addedSub.dispose();
    };
  }, [dockviewApi]);
}
