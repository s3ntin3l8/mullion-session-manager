import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { useDashboardStore } from "./store.js";
import { RefreshIcon } from "./icons.js";

// A project-bound pane re-derives everything from `projectId` on every
// mount (see the component's own comment on why); an external pane has no
// such stable identity to re-derive from, so `url` is what a restored
// workspace layout reopens to — see App.tsx's onOpenBlankBrowser
// (CommandPalette's "New browser tab") for how one gets created (empty,
// with nothing typed in yet), and the address bar below for both typing
// the first URL and renavigating an existing one. `kind` is optional, not
// a strict two-branch union, so an *older* saved workspace layout (issue
// #28 phase 4, before external panes existed — `{ projectId }` with no
// `kind` at all) keeps resolving as a project pane on restore rather than
// needing a migration.
export interface BrowserPanelParams {
  projectId?: number;
  kind?: "external";
  url?: string;
  // Historical: an earlier revision pre-created the preview before opening
  // the pane and threaded its slug in here to avoid a redundant second
  // preview row on first mount. Nothing sets this anymore (every external
  // pane now opens empty and creates its preview, if any, from this
  // component's own mount effect below) — kept only so an already-saved
  // workspace layout from before that change keeps restoring correctly
  // rather than needing a migration.
  slug?: string;
}

// "empty" only applies to a brand-new external pane with nothing typed
// into its address bar yet; every other case (including project panes)
// mirrors GitHubPanel's own loading/unavailable/ready three-state shape —
// a dockview panel opened from the Dock widget or CommandPalette's
// Integrations entry (see App.tsx/CommandPalette.tsx), where "not
// applicable" is a normal, common outcome to render inline rather than
// treat as an error.
type BrowserPanelState =
  | { status: "empty" }
  | { status: "loading" }
  | { status: "unavailable"; message: string }
  | { status: "ready"; src: string };

// A dockview panel showing a project's dev server, or an arbitrary
// external URL, both proxied same-origin at
// "preview-<slug>.<previewBaseHost>" (issue #28) — the iframe embeds
// cleanly because the proxy strips the target's own framing headers and
// the dashboard's CSP explicitly allows *.previewBaseHost as a frame-src
// (see src/plugins/preview-proxy.ts and src/plugins/security.ts).
export function BrowserPanel({ params }: { params: BrowserPanelParams }) {
  const isExternal = params.kind === "external";
  const { projects } = useDashboardStore();
  const project = isExternal ? undefined : projects.find((p) => p.id === params.projectId);
  // Extracted so the effect below references these primitives directly
  // instead of `project` itself — react-hooks/exhaustive-deps otherwise
  // wants the whole (frequently-new-reference) object in the deps array,
  // which would rerun the effect on every unrelated store update.
  const projectId = project?.id;
  const devServerUrl = project?.devServerUrl;
  // Issue #28 phase 7 — informational only here (this panel has no update
  // callback to act on it with); the actual one-click "use it" affordance
  // lives in CreateProjectModal's edit mode (Sidebar.tsx), which does.
  const detectedDevServerPort = project?.detectedDevServerPort;

  const [fetchState, setFetchState] = useState<BrowserPanelState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  // Only meaningful for external panes: renavigating via the address bar
  // updates this rather than `params.url` (a dockview panel's own params
  // are fixed at addPanel() time — there's no supported "rename my own
  // params" API), so a restored layout's `params.url` is only ever the
  // first page this pane showed, not necessarily its current one.
  const [currentUrl, setCurrentUrl] = useState(params.url ?? "");
  const [addressInput, setAddressInput] = useState(params.url ?? "");

  useEffect(() => {
    // Nothing to fetch yet — both branches below are known synchronously
    // (already-loaded store data, or "the address bar is still empty"),
    // so this effect never calls setState synchronously
    // (react-hooks/set-state-in-effect); see the derived `state` below.
    if (isExternal) {
      if (!currentUrl) return;
    } else if (!devServerUrl) {
      return;
    }

    let cancelled = false;
    api
      .getServerInfo()
      .then((info) => {
        if (cancelled) return;
        if (!info.previewsEnabled || !info.previewBaseHost) {
          // No subdomain proxy configured (PREVIEW_BASE_HOST unset) — rather
          // than a dead "unavailable" state, embed the target directly: no
          // POST /api/previews (that route isn't even registered — see
          // routes/previews.ts's own opt-in gate), just the raw URL as the
          // iframe src. security.ts's CSP frame-src allows any http(s)
          // origin in this same unset-host case, so this only fails for
          // sites that refuse embedding themselves (X-Frame-Options/
          // frame-ancestors) — the one thing the subdomain proxy buys that
          // this can't. Belt-and-suspenders checked together with
          // previewsEnabled anyway (see src/routes/server-info.ts) so a
          // future change that decouples them can't silently build an
          // invalid proxied host like "preview-<slug>./" below.
          // Non-null assertion: the effect's own early return above
          // (isExternal && !currentUrl, or !devServerUrl) already
          // guarantees whichever branch runs here has a defined value by
          // the time this line executes — TS just can't see that across
          // the isExternal ternary, same as the projectId! assertion below.
          const directUrl = isExternal ? currentUrl : devServerUrl;
          setFetchState({ status: "ready", src: directUrl! });
          return;
        }
        // Reuse the pre-created slug (see the params field's own comment)
        // only while still showing the URL it was created for — once the
        // address bar navigates elsewhere, currentUrl !== params.url and a
        // fresh preview is created for the new target.
        const previewPromise =
          isExternal && currentUrl === params.url && params.slug
            ? Promise.resolve({ slug: params.slug })
            : isExternal
              ? api.createExternalPreview(currentUrl)
              : // Non-null assertion: the effect's own early return above
                // already guarantees `projectId` is defined (and
                // devServerUrl is set) by the time this branch runs — TS
                // just can't see that across the isExternal/devServerUrl
                // guard.
                api.createProjectPreview(projectId!);
        return previewPromise.then((preview) => {
          if (cancelled) return;
          const scheme = window.location.protocol;
          setFetchState({
            status: "ready",
            src: `${scheme}//preview-${preview.slug}.${info.previewBaseHost}/`,
          });
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFetchState({
          status: "unavailable",
          message: err instanceof ApiError ? err.message : "Couldn't open this preview.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [isExternal, currentUrl, params.url, params.slug, projectId, devServerUrl, reloadKey]);

  // Checked client-side rather than relying on an iframe load failure: a
  // cross-origin iframe's load error can't be introspected from JS at all,
  // so these are the cases worth catching proactively (derived at render
  // time — see the effect's own comment on why this isn't fetchState)
  // rather than showing a blank/broken frame.
  const state: BrowserPanelState =
    !isExternal && !devServerUrl
      ? {
          status: "unavailable",
          message: detectedDevServerPort
            ? `This project has no dev server URL configured. Detected one running on port ${detectedDevServerPort} — set it in the project's settings.`
            : "This project has no dev server URL configured. Set one in the project's settings.",
        }
      : isExternal && !currentUrl
        ? { status: "empty" }
        : fetchState;

  const navigate = () => {
    const trimmed = addressInput.trim();
    if (!trimmed) return;
    setCurrentUrl(trimmed);
  };

  if (!isExternal) {
    // "empty" is unreachable for a project pane (the derivation above only
    // ever produces it when isExternal) — handled the same as "loading"
    // purely so TS can narrow `state.status === "ready"` below to the
    // `{ src }` variant without a cast.
    if (state.status === "loading" || state.status === "empty") {
      return <div className="browser-panel-empty">Loading…</div>;
    }
    if (state.status === "unavailable") {
      return <div className="browser-panel-empty">{state.message}</div>;
    }
    // "ready" — the only case left.
    return (
      <div className="browser-panel">
        <div className="browser-panel-toolbar">
          <span className="browser-panel-url" title={state.src}>
            {state.src}
          </span>
          <button
            className="browser-panel-reload"
            onClick={() => setReloadKey((k) => k + 1)}
            title="Reload"
          >
            <RefreshIcon size={13} />
          </button>
        </div>
        {/* Keyed on reloadKey so "Reload" remounts the iframe (a plain
            location.reload() inside a cross-origin frame isn't reachable
            from here) rather than trying to force a same-src navigation. */}
        <iframe key={reloadKey} className="browser-panel-frame" src={state.src} title="Preview" />
      </div>
    );
  }

  // External pane: the address bar is always shown, even before anything
  // has loaded — it's the "general-purpose browser tile" entry point
  // (issue #28's own ask), not just a display of the current URL.
  return (
    <div className="browser-panel">
      <div className="browser-panel-toolbar">
        <input
          className="browser-panel-address mono"
          value={addressInput}
          onChange={(e) => setAddressInput(e.target.value)}
          placeholder="https://example.com"
          // Only the "New browser tab" case (empty on first mount) grabs
          // focus — an already-loaded/loading/unavailable pane (restored
          // from a saved workspace layout, or reopened via a stable
          // slug-derived id) shouldn't steal focus out from under whatever
          // else the user is doing.
          autoFocus={state.status === "empty"}
          onKeyDown={(e) => {
            if (e.key === "Enter") navigate();
          }}
        />
        <button className="browser-panel-go" onClick={navigate} title="Go">
          Go
        </button>
        {state.status === "ready" && (
          <button
            className="browser-panel-reload"
            onClick={() => setReloadKey((k) => k + 1)}
            title="Reload"
          >
            <RefreshIcon size={13} />
          </button>
        )}
      </div>
      {state.status === "empty" && (
        <div className="browser-panel-empty">
          Type a URL above and press Enter. Without a configured preview proxy (PREVIEW_BASE_HOST),
          some sites refuse to be embedded (e.g. Google, GitHub) and won't load here.
        </div>
      )}
      {state.status === "loading" && <div className="browser-panel-empty">Loading…</div>}
      {state.status === "unavailable" && <div className="browser-panel-empty">{state.message}</div>}
      {state.status === "ready" && (
        <iframe key={reloadKey} className="browser-panel-frame" src={state.src} title="Preview" />
      )}
    </div>
  );
}
