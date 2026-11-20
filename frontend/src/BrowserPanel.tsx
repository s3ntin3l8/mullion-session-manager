import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, ApiError } from "./api/index.js";
import type { DockviewPanelApi } from "dockview-react";
import type { ProjectUrl, ServerInfo } from "./api/index.js";
import { useDashboardStore } from "./store/index.js";
import { usePolling } from "./hooks/usePolling.js";
import { ChevronDownIcon, RefreshIcon, StarIcon } from "./ui/icons.js";
import { SavedUrlModal } from "./SavedUrlModal.js";
import { useCoarsePointer } from "./lib/layoutTier.js";
import { describeError } from "./lib/describeError.js";
import { TextInput } from "./ui/primitives.js";
import { sessionIdFromSessionPaneId } from "./lib/panelIds.js";
import type { BrowserPanelParams } from "./lib/browserPanelParams.js";
import { addressHandoffRefusal } from "./lib/browserHandoff.js";
import type { PreviewSource } from "./lib/browserHandoff.js";

// Lives in lib/ so the store can name it without importing this component.
export type { BrowserPanelParams } from "./lib/browserPanelParams.js";

type BrowserPanelState =
  | { status: "empty" }
  | { status: "loading" }
  // retryable defaults to true (see canRetry below) — only set false for an
  // error a reload can never fix, e.g. a dangerous devServerUrl scheme that
  // will just get rejected identically on every retry.
  | { status: "unavailable"; message: string; retryable?: boolean }
  | { status: "ready"; src: string };

// The iframe-src scheme guard below (both call sites) is an anchored
// allowlist, not a denylist — deliberately fails *closed*.
//
// Dismissed in GHAS as alerts #304/#435 (js/xss-through-dom, false positive) —
// same posture as isSymlinkPath's alert #188 in src/services/dock-config.ts:
// a `codeql[...]` line comment alone would NOT have dismissed this, since
// this repo's codeql.yml has no dismiss-alerts follow-up step that reads
// SARIF suppression annotations and calls the code-scanning API; the actual
// dismissal only happened via that API directly. Three independently
// runtime-safe guard shapes were tried against this exact alert, all
// producing an identical SARIF codeFlow (dataflow jumping straight from
// resolvePreviewUrl's `targetUrl` parameter to its `return { src: targetUrl }`,
// skipping the guard entirely): a `new URL(url).protocol` helper, a regex
// `.test()` referencing a shared top-level `const` by name, and finally an
// inline regex literal `.test()` matching normalizeUrl's own barrier-guard
// style below. Since guard *shape* provably wasn't the variable, this is a
// static-analysis gap in how this query's dataflow models the
// async-function → Promise → React `setState` → JSX-render indirection this
// code goes through, not an ineffective guard.
function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return trimmed;
  return window.location.protocol + "//" + trimmed;
}

// Mirrors src/services/preview-auth.ts's PREVIEW_TOKEN_QUERY_PARAM 1:1
// (issue #383) — duplicated across the workspace boundary like every other
// backend-shape mirror in this file (frontend/ is its own npm workspace, see
// api.ts's own top-of-file comment on this convention).
const PREVIEW_TOKEN_QUERY_PARAM = "__mullion_preview";

// The one place that builds a "preview-<slug>.<baseHost>" iframe src —
// consolidated from three separate inline template strings that used to live
// here (resolvePreviewUrl below, twice, plus the project-bound preview
// effect) so the bootstrap-token query param (issue #383) only needs
// appending in one place. `token` is omitted entirely (not just empty) when
// previewAuthRequired is false, so a gate-off deployment's iframe src is
// unchanged from before this feature existed.
function buildPreviewSrc(
  scheme: string,
  slug: string,
  baseHost: string,
  token?: string,
  path?: string,
): string {
  const base = `${scheme}//preview-${slug}.${baseHost}/`;
  if (!path || path === "/") {
    return token ? `${base}?${PREVIEW_TOKEN_QUERY_PARAM}=${encodeURIComponent(token)}` : base;
  }
  // #3373 — a page the agent's browser was on. Its parts are assigned one by
  // one, never resolved against the base: a path starting with "//" must not
  // become a network-path reference that changes the authority.
  const url = new URL(base);
  const [, pathname = "/", search = "", hash = ""] = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(path) ?? [];
  url.pathname = pathname || "/";
  url.search = search;
  if (token) url.searchParams.set(PREVIEW_TOKEN_QUERY_PARAM, token);
  url.hash = hash;
  return url.href;
}

// Mints a preview's bootstrap token only when the server requires one (see
// ServerInfo.previewAuthRequired) — a no-op Promise<undefined> otherwise, so
// every call site can `await` this unconditionally.
async function mintPreviewTokenIfRequired(
  info: ServerInfo,
  slug: string,
): Promise<string | undefined> {
  if (!info.previewAuthRequired) return undefined;
  const { token } = await api.mintPreviewToken(slug);
  return token;
}

// Shown when a fetch() probe of a resolved preview `src` (isPreviewProxyError
// below) confirms one of the preview proxy's own early-return errors —
// unknown slug, PREVIEW_AUTH_REQUIRED rejection, or rate-limiting, none of
// which the devServerOnline poll above ever sees (that only covers a
// project's own dev server going offline, a distinct 502/503 case the proxy
// also produces, but same-origin-detectable another way — see this file's
// own top-of-file issue reference). Deliberately generic: this fires for
// several distinct proxy-side conditions and the probe itself can't tell
// which (see isPreviewProxyError's own comment on why the frontend never
// gets a real status code to distinguish 404 from 401 from 429).
// A branch preview (issues #2016/#2018) runs its own dev server, freshly
// started on the first open, so an unreachable proxy most likely means it
// hasn't bound its port yet.
const BRANCH_PREVIEW_STARTING_MESSAGE =
  "This branch's preview isn't reachable yet — its dev server may still be starting. " +
  "Reload in a moment.";

const PREVIEW_PROXY_ERROR_MESSAGE =
  "This preview isn't reachable through the proxy right now (it may be misconfigured, " +
  "require authentication, or be rate-limited). Try again in a moment.";

// Issue #1318 — src/plugins/preview-proxy.ts now sends
// Access-Control-Allow-Origin on exactly its own early-return error
// responses (404 unknown slug, 401 PREVIEW_AUTH_REQUIRED, 429 rate-limited,
// 502/503 dev server down) and NEVER on a real proxied response (the
// previewed dev server's own content stays exactly as CORS-opaque as
// before). That split is what makes this probe meaningful: a *readable*
// non-2xx response is a genuine proxy error worth surfacing; a thrown fetch
// (a network-level CORS failure — no ACAO header at all, the common case of
// a real successful load) tells us nothing, so it's treated as "probably
// fine" and the caller falls back to mounting the iframe exactly as it did
// before this probe existed. The probe uses redirect: "manual" (without
// credentials: "include") so credentials are not transferred cross-origin
// (avoiding CodeQL js/cors-misconfiguration-for-credentials alerts), while
// allowing the uncredentialed error status to be read.
async function isPreviewProxyError(src: string): Promise<boolean> {
  try {
    const response = await fetch(src, { redirect: "manual" });
    if (response.type === "opaqueredirect" || response.status === 302) {
      return false;
    }
    return !response.ok;
  } catch {
    return false;
  }
}

async function resolvePreviewUrl(
  targetUrl: string,
  existingSlug?: string,
): Promise<{ src: string } | { error: string }> {
  if (!/^https?:\/\//i.test(targetUrl)) {
    return { error: "This URL's scheme can't be previewed here." };
  }
  try {
    const info = await api.getServerInfo();
    if (!info.previewsEnabled || !info.previewBaseHost) {
      return { src: targetUrl };
    }
    const scheme = window.location.protocol;
    const slug = existingSlug ?? (await api.createExternalPreview(targetUrl)).slug;
    const token = await mintPreviewTokenIfRequired(info, slug);
    const src = buildPreviewSrc(scheme, slug, info.previewBaseHost, token);
    if (await isPreviewProxyError(src)) {
      return { error: PREVIEW_PROXY_ERROR_MESSAGE };
    }
    return { src };
  } catch (err: unknown) {
    return { error: err instanceof ApiError ? err.message : "Couldn't open this URL." };
  }
}

export function BrowserPanel({
  params,
  api: panelApi,
  toolbarStart,
  toolbarEnd,
  onSourceChange,
  onShowInAgentBrowser,
}: {
  params: BrowserPanelParams;
  api?: Pick<DockviewPanelApi, "updateParameters">;
  /** Rendered first in the toolbar: the Browser pane's mode switch (#3371). */
  toolbarStart?: ReactNode;
  /** Rendered last in the toolbar, after reload. */
  toolbarEnd?: ReactNode;
  /** #3373 — what the preview loaded, for the ⇄ button. Never the iframe's
   * address (see PreviewSource). */
  onSourceChange?: (source: PreviewSource | null) => void;
  /** #3373 — opens the current address in the agent's browser; offered in
   * an external preview's "unavailable" state. */
  onShowInAgentBrowser?: () => void;
}) {
  // Dockview replaces the full params object on write-back. Keep the latest
  // snapshot without making that write effect depend on its own output.
  const paramsRef = useRef(params);
  useEffect(() => {
    paramsRef.current = params;
  }, [params]);
  const isExternal = params.kind === "external";
  const { projects, projectUrls, refreshProjectUrls } = useDashboardStore();
  const isCoarsePointer = useCoarsePointer();
  const project = isExternal ? undefined : projects.find((p) => p.id === params.projectId);
  const projectId = project?.id;
  const devServerUrl = project?.devServerUrl;
  const detectedDevServerPort = project?.detectedDevServerPort;
  // Issues #2016/#2018 — a pane opened on one branch preview carries its
  // slug. The proxy resolves that slug to the preview's own dock session, so
  // the project's devServerUrl (the checkout's dev server) plays no part.
  const previewSlug = isExternal ? undefined : params.previewSlug;

  const initialUrl = params.url ? normalizeUrl(params.url) : "";
  const [fetchState, setFetchState] = useState<BrowserPanelState>({ status: "loading" });
  // Whether the current project-bound fetchState went through the preview
  // proxy (buildPreviewSrc/preview-<slug> subdomain) rather than embedding
  // devServerUrl directly (the previewsEnabled/previewBaseHost-unset
  // fallback, which predates the preview proxy entirely). Only the proxied
  // path can produce the raw-JSON/HTML proxy error this feature targets —
  // a direct embed's own connection failures are the iframe's native error
  // page, already covered by the devServerOnline dot alone (see
  // "Remediation Plan Additions" in BrowserPanel.test.tsx), and gating the
  // devServerOnline-derived override on this keeps that existing dot+iframe
  // behavior intact.
  const [previewViaProxy, setPreviewViaProxy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // #3373 — the page to open below the project preview's root. Cleared when
  // the user picks another target from the dropdown.
  const [previewPath, setPreviewPath] = useState(params.previewPath);
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [addressInput, setAddressInput] = useState(initialUrl);
  const [activeSavedUrlId, setActiveSavedUrlId] = useState<number | null>(
    params.activeSavedUrlId ?? null,
  );
  const [activeSavedUrlLabel, setActiveSavedUrlLabel] = useState<string | null>(
    params.activeSavedUrlLabel ?? null,
  );
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [favoriteUrls, setFavoriteUrls] = useState<ProjectUrl[]>([]);
  const [favDropdownOpen, setFavDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const favDropdownRef = useRef<HTMLDivElement>(null);

  const stableEmptyUrls = useMemo<ProjectUrl[]>(() => [], []);
  const savedUrls = projectId ? (projectUrls[projectId] ?? stableEmptyUrls) : stableEmptyUrls;

  useEffect(() => {
    if (projectId) void refreshProjectUrls(projectId);
  }, [projectId, refreshProjectUrls]);

  useEffect(() => {
    if (!isExternal) return;
    let cancelled = false;
    api
      .listFavoriteUrls()
      .then((urls: ProjectUrl[]) => {
        if (!cancelled) setFavoriteUrls(urls);
      })
      .catch((err) => {
        // This used to be console-only, and the effect of that was that a
        // failed fetch looked exactly like "you have no favorites" — the
        // dropdown button simply never renders, with nothing to say why
        // (audit finding 30). The panel itself still works, so this is not
        // an inline panel error; it is a transient background failure, and
        // the app-wide toast is the surface for exactly that.
        console.warn("[BrowserPanel] Failed to fetch favorites", err);
        if (!cancelled) {
          useDashboardStore
            .getState()
            .reportError("Could not load your favorites.", describeError(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isExternal]);

  // Main URL resolving effect
  useEffect(() => {
    if (isExternal) {
      if (!currentUrl) return;
      let cancelled = false;
      const reuseSlug = currentUrl === params.url ? params.slug : undefined;
      resolvePreviewUrl(currentUrl, reuseSlug).then((result) => {
        if (cancelled) return;
        if ("error" in result) {
          setFetchState({ status: "unavailable", message: result.error });
        } else {
          setFetchState({ status: "ready", src: result.src });
        }
      });
      return () => {
        cancelled = true;
      };
    } else {
      // Project-bound preview
      let cancelled = false;

      if (activeSavedUrlId !== null) {
        if (savedUrls.length === 0) {
          return;
        }
        const saved = savedUrls.find((u) => u.id === activeSavedUrlId);
        if (!saved) {
          Promise.resolve().then(() => {
            setActiveSavedUrlId(null);
            setActiveSavedUrlLabel(null);
          });
          return;
        }
        Promise.resolve().then(() => {
          setFetchState({ status: "loading" });
        });
        resolvePreviewUrl(saved.url).then((result) => {
          if (cancelled) return;
          if ("error" in result) {
            setFetchState({ status: "unavailable", message: result.error });
          } else {
            setFetchState({ status: "ready", src: result.src });
          }
        });
        return () => {
          cancelled = true;
        };
      }

      if (previewSlug) {
        void (async () => {
          try {
            const info = await api.getServerInfo();
            if (cancelled) return;
            if (!info.previewsEnabled || !info.previewBaseHost) {
              setFetchState({
                status: "unavailable",
                message: "Previews are not enabled on this server.",
                retryable: false,
              });
              return;
            }
            const token = await mintPreviewTokenIfRequired(info, previewSlug);
            if (cancelled) return;
            setPreviewViaProxy(true);
            const src = buildPreviewSrc(
              window.location.protocol,
              previewSlug,
              info.previewBaseHost,
              token,
              previewPath,
            );
            if (await isPreviewProxyError(src)) {
              if (cancelled) return;
              // Most often the branch's dev server is still starting.
              setFetchState({
                status: "unavailable",
                message: params.targetName
                  ? "This preview target is not reachable. Check its configured destination and connection origin, then retry."
                  : BRANCH_PREVIEW_STARTING_MESSAGE,
              });
              return;
            }
            if (cancelled) return;
            setFetchState({ status: "ready", src });
          } catch (err: unknown) {
            if (cancelled) return;
            setFetchState({
              status: "unavailable",
              message: err instanceof ApiError ? err.message : "Couldn't open this preview.",
            });
          }
        })();
        return () => {
          cancelled = true;
        };
      }

      if (!devServerUrl) return;
      void (async () => {
        try {
          const info = await api.getServerInfo();
          if (cancelled) return;
          if (!info.previewsEnabled || !info.previewBaseHost) {
            // Unlike the resolvePreviewUrl() paths (saved URLs, external URLs,
            // Follow Agent), this previewsEnabled=false fallback embeds
            // devServerUrl directly without going through that function's own
            // scheme gate — it's project-settings-sourced rather than freshly
            // typed, but the iframe sink shouldn't trust that; check it here
            // too (CodeQL js/xss-through-dom, BrowserPanel.tsx iframe src).
            // A bare port is also accepted, mirroring DEV_SERVER_PORT_ONLY in
            // src/routes/projects.ts's own parseDevServerTarget/
            // isValidDevServerUrl — a project's devServerUrl is stored as
            // either a bare 1-65535 port or a full http(s) URL, never any
            // other shape (BrowserPanel.test.tsx embeds a bare port directly
            // as the iframe src, unprefixed, matching that stored shape).
            if (!/^\d{1,5}$/.test(devServerUrl) && !/^https?:\/\//i.test(devServerUrl)) {
              setPreviewViaProxy(false);
              setFetchState({
                status: "unavailable",
                message: "This dev server URL's scheme can't be previewed here.",
                retryable: false,
              });
              return;
            }
            setPreviewViaProxy(false);
            setFetchState({ status: "ready", src: devServerUrl });
            return;
          }
          const preview = await api.createProjectPreview(projectId!);
          if (cancelled) return;
          const token = await mintPreviewTokenIfRequired(info, preview.slug);
          if (cancelled) return;
          setPreviewViaProxy(true);
          const src = buildPreviewSrc(
            window.location.protocol,
            preview.slug,
            info.previewBaseHost,
            token,
            previewPath,
          );
          if (await isPreviewProxyError(src)) {
            if (cancelled) return;
            setFetchState({ status: "unavailable", message: PREVIEW_PROXY_ERROR_MESSAGE });
            return;
          }
          if (cancelled) return;
          setFetchState({ status: "ready", src });
        } catch (err: unknown) {
          if (cancelled) return;
          setFetchState({
            status: "unavailable",
            message: err instanceof ApiError ? err.message : "Couldn't open this preview.",
          });
        }
      })();

      return () => {
        cancelled = true;
      };
    }
  }, [
    isExternal,
    currentUrl,
    projectId,
    devServerUrl,
    previewSlug,
    params.targetName,
    params.targetRev,
    reloadKey,
    activeSavedUrlId,
    savedUrls,
    previewPath,
  ]);

  // Update dockview parameters so layout saves/restores the current URL/slug correctly.
  useEffect(() => {
    if (!panelApi) return;
    const slug =
      fetchState.status === "ready"
        ? fetchState.src.match(/\/\/preview-([^.]+)\./)?.[1] || undefined
        : undefined;
    panelApi.updateParameters({
      ...paramsRef.current,
      url: currentUrl,
      slug,
      activeSavedUrlId,
      activeSavedUrlLabel,
      previewPath,
    });
  }, [panelApi, currentUrl, fetchState, activeSavedUrlId, activeSavedUrlLabel, previewPath]);

  // Follow Agent URL sync
  const activeSessionId = useDashboardStore((s) => sessionIdFromSessionPaneId(s.activePanelId));

  const activeSession = useDashboardStore((s) =>
    activeSessionId !== null ? s.sessions.find((sess) => sess.id === activeSessionId) : undefined,
  );

  const [followAgent, setFollowAgent] = useState(false);

  useEffect(() => {
    if (!followAgent || !activeSession?.browserUrl) return;

    let cancelled = false;
    resolvePreviewUrl(activeSession.browserUrl).then((result) => {
      if (cancelled) return;
      if ("error" in result) {
        setFetchState({ status: "unavailable", message: result.error });
      } else {
        setFetchState({ status: "ready", src: result.src });
        setCurrentUrl(activeSession.browserUrl ?? "");
        setAddressInput(activeSession.browserUrl ?? "");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [followAgent, activeSession?.browserUrl]);

  // Dev server status indicator
  const [devServerOnline, setDevServerOnline] = useState<boolean | null>(null);

  // Whether the current iframe (this src + reloadKey combo) has ever fired
  // `load`. Used below to gate the devServerOnline-derived error override:
  // once something has loaded, a later poll tick that flips devServerOnline
  // to false (a transient blip, or the dev server dying mid-session) must
  // not tear down a frame the user may be actively interacting with — see
  // this file's own note above on the poll's 5s cadence. Reset on every
  // src/reloadKey change so a fresh attempt starts un-loaded again — done
  // during render (React's documented "adjusting state when a prop
  // changes" bailout), not a useEffect, since a setState synchronously
  // inside an effect body trips this repo's react-hooks/set-state-in-effect
  // lint rule.
  const [frameLoaded, setFrameLoaded] = useState(false);
  const readySrc = fetchState.status === "ready" ? fetchState.src : undefined;
  const frameIdentity = `${reloadKey}:${readySrc ?? ""}`;
  const [trackedFrameIdentity, setTrackedFrameIdentity] = useState(frameIdentity);
  if (trackedFrameIdentity !== frameIdentity) {
    setTrackedFrameIdentity(frameIdentity);
    setFrameLoaded(false);
  }

  // Behavior note: the pre-extraction effect's own dependency array was
  // `[isExternal, projectId]` only — `devServerUrl` gated the early return
  // but wasn't a listed dependency, so a `devServerUrl` that went from
  // falsy to truthy without `isExternal`/`projectId` also changing left
  // this poll permanently un-started until one of those two DID change.
  // `enabled` below recomputes (and, via usePolling's own restart-on-
  // `enabled`-change behavior, correctly starts the poll) whenever any of
  // the three flips — a small, deliberate fix riding along with this
  // extraction, not a silent behavior change: this is strictly "the poll
  // now starts in a case it previously wouldn't have", never the reverse.
  usePolling(
    (isCancelled) => {
      if (!projectId) return;
      api
        .getDevServerStatus(projectId)
        .then((res: { online: boolean }) => {
          if (!isCancelled()) setDevServerOnline(res.online);
        })
        .catch(() => {
          if (!isCancelled()) setDevServerOnline(false);
        });
    },
    5000,
    {
      enabled: !isExternal && !!projectId && !!devServerUrl && !previewSlug,
      deps: [isExternal, projectId],
    },
  );

  const navigateToSavedUrl = (id: number, url: string, label: string) => {
    setFollowAgent(false);
    setPreviewPath(undefined);
    setActiveSavedUrlId(id);
    setActiveSavedUrlLabel(label);
    setDropdownOpen(false);
    setFetchState({ status: "loading" });
    setCurrentUrl(url);
  };

  const navigateToDevServer = () => {
    setFollowAgent(false);
    setPreviewPath(undefined);
    setActiveSavedUrlId(null);
    setActiveSavedUrlLabel(null);
    setDropdownOpen(false);
    if (devServerUrl) {
      setCurrentUrl(devServerUrl);
    } else {
      setReloadKey((k) => k + 1);
    }
  };

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
      if (favDropdownRef.current && !favDropdownRef.current.contains(e.target as Node)) {
        setFavDropdownOpen(false);
      }
    }
    if (dropdownOpen || favDropdownOpen) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [dropdownOpen, favDropdownOpen]);

  // A cross-origin preview iframe can't be probed for its response status
  // from here (no CORS headers on either the dev server's own responses or
  // the proxy's error branches, so a fetch() to the preview URL fails
  // identically for a 200 and a 404/502/503 — see this PR's own commit
  // message for why that rules out both options the originating issue
  // proposed). devServerOnline (polled above, already same-origin via our
  // own API) is the one signal already available for the dominant case:
  // the proxy returning 502/503 because the dev server itself is down.
  // Gated on `=== false` (not just falsy) so the null "haven't polled yet"
  // state never flashes this, and on `!frameLoaded` so it never yanks away
  // an iframe that's already showing something.
  const devServerUnreachable =
    !isExternal &&
    activeSavedUrlId === null &&
    !!devServerUrl &&
    !previewSlug &&
    previewViaProxy &&
    devServerOnline === false &&
    !frameLoaded;

  const state: BrowserPanelState =
    !isExternal && activeSavedUrlId === null && !devServerUrl && !previewSlug
      ? {
          status: "unavailable",
          message: detectedDevServerPort
            ? `This project has no dev server URL configured. Detected one running on port ${detectedDevServerPort} — set it in the project's settings.`
            : "This project has no dev server URL configured. Set one in the project's settings.",
        }
      : devServerUnreachable
        ? {
            status: "unavailable",
            message:
              "Dev server not reachable. It may have crashed or stopped — check the session, then retry.",
          }
        : isExternal && !currentUrl
          ? { status: "empty" }
          : fetchState;

  // #3373 — what the preview loaded, for ⇄. A cross-origin iframe does not
  // report where the user clicked, so this is the address it was given: the
  // one typed, saved or followed, or the project preview it shows by slug.
  const savedUrlAddress =
    activeSavedUrlId !== null ? savedUrls.find((u) => u.id === activeSavedUrlId)?.url : undefined;
  const source = useMemo<PreviewSource | null>(() => {
    if (isExternal || followAgent) return currentUrl ? { kind: "address", url: currentUrl } : null;
    if (activeSavedUrlId !== null) {
      return savedUrlAddress ? { kind: "address", url: normalizeUrl(savedUrlAddress) } : null;
    }
    if (previewSlug) return { kind: "project", slug: previewSlug };
    return devServerUrl ? { kind: "project" } : null;
  }, [
    isExternal,
    followAgent,
    currentUrl,
    activeSavedUrlId,
    savedUrlAddress,
    previewSlug,
    devServerUrl,
  ]);
  const onSourceChangeRef = useRef(onSourceChange);
  useEffect(() => {
    onSourceChangeRef.current = onSourceChange;
  });
  useEffect(() => {
    onSourceChangeRef.current?.(source);
  }, [source]);

  const navigate = () => {
    setFollowAgent(false);
    const normalized = normalizeUrl(addressInput);
    if (!normalized) return;
    setAddressInput(normalized);
    setActiveSavedUrlId(null);
    setActiveSavedUrlLabel(null);
    setCurrentUrl(normalized);
  };

  // A project preview that has nothing to show yet returns a bare message.
  // Inside the Browser pane it still needs its toolbar, or the mode switch
  // would go missing exactly when the preview cannot load (#3371).
  const hasToolbarSlots = toolbarStart != null || toolbarEnd != null;
  const withToolbar = (body: ReactNode) =>
    hasToolbarSlots ? (
      <div className="browser-panel">
        <div className="browser-panel-toolbar">
          {toolbarStart}
          <span className="browser-panel-url" />
          {toolbarEnd}
        </div>
        {body}
      </div>
    ) : (
      body
    );

  if (!isExternal) {
    if (state.status === "loading" || state.status === "empty") {
      return withToolbar(<div className="browser-panel-empty">Loading…</div>);
    }
    if (state.status === "unavailable") {
      // Retry only offered once there's actually a dev server/saved URL to
      // retry against — the sibling "no dev server URL configured" message
      // above needs a settings change, not a reload, to ever resolve. Same
      // for state.retryable === false (e.g. a dangerous devServerUrl scheme):
      // a reload re-runs the identical, still-dangerous URL through the same
      // check every time.
      const canRetry =
        (!!devServerUrl || !!previewSlug || activeSavedUrlId !== null || isExternal) &&
        state.retryable !== false;
      return withToolbar(
        <div className="browser-panel-empty">
          <div>{state.message}</div>
          {canRetry && (
            <button
              className="browser-panel-go"
              style={{ marginTop: 8 }}
              onClick={() => setReloadKey((k) => k + 1)}
            >
              Retry
            </button>
          )}
        </div>,
      );
    }
    const currentLabel = params.targetName ?? activeSavedUrlLabel ?? "Dev server";
    const currentSrc = state.status === "ready" ? state.src : "";
    return (
      <div className="browser-panel">
        <div className="browser-panel-toolbar">
          {toolbarStart}
          {params.targetName ? (
            <span className="browser-panel-dropdown-label">{params.targetName}</span>
          ) : (
            <div className="browser-panel-dropdown" ref={dropdownRef}>
              <button
                className="browser-panel-dropdown-btn"
                onClick={() => setDropdownOpen((v) => !v)}
              >
                <span className="browser-panel-dropdown-label">{currentLabel}</span>
                <ChevronDownIcon size={11} />
              </button>
              {dropdownOpen && (
                <div className="browser-panel-dropdown-menu">
                  <button
                    className={`browser-panel-dropdown-item${activeSavedUrlId === null ? " active" : ""}`}
                    onClick={navigateToDevServer}
                  >
                    Dev server
                  </button>
                  {savedUrls.length > 0 && <div className="browser-panel-dropdown-separator" />}
                  {savedUrls.map((u) => (
                    <button
                      key={u.id}
                      className={`browser-panel-dropdown-item${activeSavedUrlId === u.id ? " active" : ""}`}
                      onClick={() => navigateToSavedUrl(u.id, u.url, u.label)}
                    >
                      {u.favorite && <span className="browser-panel-dropdown-star">★</span>}
                      {u.label}
                    </button>
                  ))}
                  <div className="browser-panel-dropdown-separator" />
                  <button
                    className="browser-panel-dropdown-item"
                    onClick={() => {
                      setDropdownOpen(false);
                      setModalOpen(true);
                    }}
                  >
                    Manage URLs…
                  </button>
                </div>
              )}
            </div>
          )}
          <span className="browser-panel-url" title={currentSrc}>
            {state.src}
          </span>
          {devServerOnline !== null && (
            <span
              className={`dev-server-status-dot ${devServerOnline ? "online" : "offline"}`}
              title={devServerOnline ? "Dev server online" : "Dev server offline"}
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: devServerOnline ? "var(--g, #2ea44f)" : "var(--r, #cb2431)",
                marginLeft: 6,
                marginRight: 6,
                flexShrink: 0,
              }}
            />
          )}
          {activeSession && (
            <button
              className={`browser-panel-follow${followAgent ? " active" : ""}`}
              onClick={() => setFollowAgent((f) => !f)}
              title="Follow Agent URL Sync"
              style={{
                whiteSpace: "nowrap",
                fontSize: "0.6875rem",
                padding: "0 6px",
                marginRight: 6,
                display: "flex",
                alignItems: "center",
                gap: 4,
                height: 22,
                borderRadius: 5,
                border: "1px solid transparent",
                cursor: "pointer",
                backgroundColor: followAgent
                  ? "var(--active-bg, color-mix(in srgb, var(--b) 12%, transparent))"
                  : "transparent",
                borderColor: followAgent ? "var(--border-active, var(--b))" : "transparent",
                color: followAgent ? "var(--b, var(--fg))" : "var(--muted)",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: followAgent ? "var(--g, #2ea44f)" : "var(--dim, #888)",
                }}
              />
              Follow Agent
            </button>
          )}
          <button
            className="browser-panel-reload"
            onClick={() => {
              setFollowAgent(false);
              setReloadKey((k) => k + 1);
            }}
            title="Reload"
          >
            <RefreshIcon size={13} />
          </button>
          {toolbarEnd}
        </div>
        <iframe
          key={`${reloadKey}:${params.targetRev ?? 0}`}
          className="browser-panel-frame"
          src={state.src}
          title="Preview"
          onLoad={() => setFrameLoaded(true)}
        />
        {modalOpen && project && (
          <SavedUrlModal
            projectId={project.id}
            projectName={project.name}
            onClose={() => {
              setModalOpen(false);
              void refreshProjectUrls(project.id);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="browser-panel">
      {/* No back and forward here: a cross-origin iframe's history cannot be
          read, so the Browser pane offers them in Agent's browser only
          (#3371). */}
      <div className="browser-panel-toolbar">
        {toolbarStart}
        <TextInput
          small
          className="browser-panel-address mono"
          value={addressInput}
          onChange={(e) => setAddressInput(e.target.value)}
          placeholder="https://example.com"
          // Mobile UI/UX overhaul, item B.5 — the one genuine "keyboard pops
          // up unwanted" case left after re-auditing every autoFocus/.focus()
          // call site in the app: every other one is gated behind an
          // explicit user action (clicking Rename/Create/Add/Deny, or the
          // login screen itself) — this one fires the instant an empty
          // browser panel mounts, with no click involved, popping the
          // keyboard before the user has asked to type a URL. Tablet tier
          // plan, PR 4 — gated on pointer coarseness (independent review:
          // was briefly tier-gated, which had it backwards — a touchscreen
          // laptop at desktop width would still pop the keyboard, and an
          // explicit `layoutMode: "tablet"` override on a mouse/trackpad
          // device would lose autofocus it doesn't need to), same as the
          // key bar and 44px hit targets elsewhere in this plan.
          autoFocus={state.status === "empty" && !isCoarsePointer}
          onKeyDown={(e) => {
            if (e.key === "Enter") navigate();
          }}
        />
        <button className="browser-panel-go" onClick={navigate} title="Go">
          Go
        </button>
        {favoriteUrls.length > 0 && (
          <div className="browser-panel-dropdown" ref={favDropdownRef}>
            <button
              className="browser-panel-dropdown-btn"
              onClick={() => setFavDropdownOpen((v) => !v)}
              title="Favorites"
            >
              <StarIcon size={11} />
              <ChevronDownIcon size={10} />
            </button>
            {favDropdownOpen && (
              <div className="browser-panel-dropdown-menu">
                {favoriteUrls.map((u) => {
                  const projectName = projects.find((p) => p.id === u.projectId)?.name;
                  return (
                    <button
                      key={u.id}
                      className="browser-panel-dropdown-item"
                      onClick={() => {
                        const favUrl = normalizeUrl(u.url);
                        setFollowAgent(false);
                        setFavDropdownOpen(false);
                        setAddressInput(favUrl);
                        setActiveSavedUrlId(null);
                        setActiveSavedUrlLabel(null);
                        setCurrentUrl(favUrl);
                      }}
                    >
                      <span className="browser-panel-dropdown-star">★</span>
                      {u.label}
                      {projectName && (
                        <span className="browser-panel-dropdown-project">({projectName})</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {activeSession && (
          <button
            className={`browser-panel-follow${followAgent ? " active" : ""}`}
            onClick={() => setFollowAgent((f) => !f)}
            title="Follow Agent URL Sync"
            style={{
              whiteSpace: "nowrap",
              fontSize: "0.6875rem",
              padding: "0 6px",
              marginRight: 6,
              display: "flex",
              alignItems: "center",
              gap: 4,
              height: 22,
              borderRadius: 5,
              border: "1px solid transparent",
              cursor: "pointer",
              backgroundColor: followAgent
                ? "var(--active-bg, color-mix(in srgb, var(--b) 12%, transparent))"
                : "transparent",
              borderColor: followAgent ? "var(--border-active, var(--b))" : "transparent",
              color: followAgent ? "var(--b, var(--fg))" : "var(--muted)",
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: followAgent ? "var(--g, #2ea44f)" : "var(--dim, #888)",
              }}
            />
            Follow Agent
          </button>
        )}
        <button
          className="browser-panel-reload"
          onClick={() => {
            setFollowAgent(false);
            setReloadKey((k) => k + 1);
          }}
          title="Reload"
        >
          <RefreshIcon size={13} />
        </button>
        {toolbarEnd}
      </div>
      {state.status === "empty" && (
        <div className="browser-panel-empty">
          Type a URL above and press Enter. Without a configured preview proxy (PREVIEW_BASE_HOST),
          some sites refuse to be embedded (e.g. Google, GitHub) and won't load here.
        </div>
      )}
      {state.status === "loading" && <div className="browser-panel-empty">Loading…</div>}
      {state.status === "unavailable" && (
        <div className="browser-panel-empty">
          <div>{state.message}</div>
          {/* #3373 — the agent's browser loads what an iframe cannot. Offered
              only for an address it would accept. */}
          {onShowInAgentBrowser && addressHandoffRefusal(currentUrl) === null && (
            <>
              <div style={{ marginTop: 8 }}>
                This site cannot be shown as a preview. The agent's browser can show it.
              </div>
              <button
                className="browser-panel-go"
                style={{ marginTop: 8 }}
                onClick={onShowInAgentBrowser}
              >
                Open in the agent's browser
              </button>
            </>
          )}
        </div>
      )}
      {state.status === "ready" && (
        <iframe
          key={`${reloadKey}:${params.targetRev ?? 0}`}
          className="browser-panel-frame"
          src={state.src}
          title="Preview"
        />
      )}
    </div>
  );
}
