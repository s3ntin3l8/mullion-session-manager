import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api/index.js";
import type { DockviewPanelApi } from "dockview-react";
import type { ProjectUrl, ServerInfo } from "./api/index.js";
import { useDashboardStore } from "./store/index.js";
import { usePolling } from "./hooks/usePolling.js";
import { ChevronDownIcon, RefreshIcon, StarIcon } from "./ui/icons.js";
import { SavedUrlModal } from "./SavedUrlModal.js";

export interface BrowserPanelParams {
  projectId?: number;
  kind?: "external";
  url?: string;
  slug?: string;
  activeSavedUrlId?: number | null;
  activeSavedUrlLabel?: string | null;
}

type BrowserPanelState =
  | { status: "empty" }
  | { status: "loading" }
  | { status: "unavailable"; message: string }
  | { status: "ready"; src: string };

// Mirrors App.tsx's/panelUtils.ts's own private MOBILE_BREAKPOINT_QUERY —
// see panelUtils.ts's comment on why this stays a small per-file duplicate
// rather than a shared export.
const MOBILE_BREAKPOINT_QUERY = "(max-width: 699px)";

function isDangerousIframeSrc(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol !== "http:" && protocol !== "https:";
  } catch {
    return false;
  }
}

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
function buildPreviewSrc(scheme: string, slug: string, baseHost: string, token?: string): string {
  const base = `${scheme}//preview-${slug}.${baseHost}/`;
  return token ? `${base}?${PREVIEW_TOKEN_QUERY_PARAM}=${encodeURIComponent(token)}` : base;
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

async function resolvePreviewUrl(
  targetUrl: string,
  existingSlug?: string,
): Promise<{ src: string } | { error: string }> {
  if (isDangerousIframeSrc(targetUrl)) {
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
    return { src: buildPreviewSrc(scheme, slug, info.previewBaseHost, token) };
  } catch (err: unknown) {
    return { error: err instanceof ApiError ? err.message : "Couldn't open this URL." };
  }
}

export function BrowserPanel({
  params,
  api: panelApi,
}: {
  params: BrowserPanelParams;
  api?: DockviewPanelApi;
}) {
  const isExternal = params.kind === "external";
  const { projects, projectUrls, refreshProjectUrls } = useDashboardStore();
  const project = isExternal ? undefined : projects.find((p) => p.id === params.projectId);
  const projectId = project?.id;
  const devServerUrl = project?.devServerUrl;
  const detectedDevServerPort = project?.detectedDevServerPort;

  const initialUrl = params.url ? normalizeUrl(params.url) : "";
  const [fetchState, setFetchState] = useState<BrowserPanelState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
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
  const [urlHistory, setUrlHistory] = useState<string[]>(initialUrl ? [initialUrl] : []);
  const [historyIndex, setHistoryIndex] = useState(initialUrl ? 0 : -1);
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
      .catch(() => {
        console.warn("[BrowserPanel] Failed to fetch favorites");
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

      if (!devServerUrl) return;
      void (async () => {
        try {
          const info = await api.getServerInfo();
          if (cancelled) return;
          if (!info.previewsEnabled || !info.previewBaseHost) {
            setFetchState({ status: "ready", src: devServerUrl! });
            return;
          }
          const preview = await api.createProjectPreview(projectId!);
          if (cancelled) return;
          const token = await mintPreviewTokenIfRequired(info, preview.slug);
          if (cancelled) return;
          setFetchState({
            status: "ready",
            src: buildPreviewSrc(
              window.location.protocol,
              preview.slug,
              info.previewBaseHost,
              token,
            ),
          });
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
  }, [isExternal, currentUrl, projectId, devServerUrl, reloadKey, activeSavedUrlId, savedUrls]);

  // Update dockview parameters so layout saves/restores the current URL/slug correctly.
  useEffect(() => {
    if (!panelApi) return;
    const slug =
      fetchState.status === "ready"
        ? fetchState.src.match(/\/\/preview-([^.]+)\./)?.[1] || undefined
        : undefined;
    panelApi.updateParameters({
      url: currentUrl,
      slug,
      activeSavedUrlId,
      activeSavedUrlLabel,
    });
  }, [panelApi, currentUrl, fetchState, activeSavedUrlId, activeSavedUrlLabel]);

  // Follow Agent URL sync
  const activeSessionId = useDashboardStore((s) => {
    if (!s.activePanelId) return null;
    const match = s.activePanelId.match(/^(?:session|timeline|browserPane)-(\d+)$/);
    return match ? parseInt(match[1], 10) : null;
  });

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
    { enabled: !isExternal && !!projectId && !!devServerUrl, deps: [isExternal, projectId] },
  );

  const navigateToSavedUrl = (id: number, url: string, label: string) => {
    setFollowAgent(false);
    setActiveSavedUrlId(id);
    setActiveSavedUrlLabel(label);
    setDropdownOpen(false);
    setFetchState({ status: "loading" });
    setCurrentUrl(url);
  };

  const navigateToDevServer = () => {
    setFollowAgent(false);
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

  const state: BrowserPanelState =
    !isExternal && activeSavedUrlId === null && !devServerUrl
      ? {
          status: "unavailable",
          message: detectedDevServerPort
            ? `This project has no dev server URL configured. Detected one running on port ${detectedDevServerPort} — set it in the project's settings.`
            : "This project has no dev server URL configured. Set one in the project's settings.",
        }
      : isExternal && !currentUrl
        ? { status: "empty" }
        : fetchState;

  const pushToHistory = (url: string) => {
    const newHistory = urlHistory.slice(0, historyIndex + 1);
    newHistory.push(url);
    setUrlHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
  };

  const navigate = () => {
    setFollowAgent(false);
    const normalized = normalizeUrl(addressInput);
    if (!normalized) return;
    setAddressInput(normalized);
    setActiveSavedUrlId(null);
    setActiveSavedUrlLabel(null);
    pushToHistory(normalized);
    setCurrentUrl(normalized);
  };

  const goBack = () => {
    setFollowAgent(false);
    if (historyIndex <= 0) return;
    const newIndex = historyIndex - 1;
    setHistoryIndex(newIndex);
    const url = urlHistory[newIndex];
    setAddressInput(url);
    setActiveSavedUrlId(null);
    setActiveSavedUrlLabel(null);
    setCurrentUrl(url);
  };

  const goForward = () => {
    setFollowAgent(false);
    if (historyIndex >= urlHistory.length - 1) return;
    const newIndex = historyIndex + 1;
    setHistoryIndex(newIndex);
    const url = urlHistory[newIndex];
    setAddressInput(url);
    setActiveSavedUrlId(null);
    setActiveSavedUrlLabel(null);
    setCurrentUrl(url);
  };

  if (!isExternal) {
    if (state.status === "loading" || state.status === "empty") {
      return <div className="browser-panel-empty">Loading…</div>;
    }
    if (state.status === "unavailable") {
      return <div className="browser-panel-empty">{state.message}</div>;
    }
    const currentLabel = activeSavedUrlLabel ?? "Dev server";
    const currentSrc = state.status === "ready" ? state.src : "";
    return (
      <div className="browser-panel">
        <div className="browser-panel-toolbar">
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
                fontSize: 11,
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
        </div>
        <iframe key={reloadKey} className="browser-panel-frame" src={state.src} title="Preview" />
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
      <div className="browser-panel-toolbar">
        <button
          className="browser-panel-reload"
          disabled={historyIndex <= 0}
          onClick={goBack}
          title="Back"
        >
          ‹
        </button>
        <button
          className="browser-panel-reload"
          disabled={historyIndex >= urlHistory.length - 1}
          onClick={goForward}
          title="Forward"
        >
          ›
        </button>
        <input
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
          // keyboard on mobile before the user has asked to type a URL.
          autoFocus={
            state.status === "empty" && !window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches
          }
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
                        pushToHistory(favUrl);
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
              fontSize: 11,
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
