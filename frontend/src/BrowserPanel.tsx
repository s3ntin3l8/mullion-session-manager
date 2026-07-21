import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api.js";
import { useDashboardStore } from "./store.js";
import { ChevronDownIcon, RefreshIcon } from "./icons.js";
import { SavedUrlModal } from "./SavedUrlModal.js";

export interface BrowserPanelParams {
  projectId?: number;
  kind?: "external";
  url?: string;
  slug?: string;
}

type BrowserPanelState =
  | { status: "empty" }
  | { status: "loading" }
  | { status: "unavailable"; message: string }
  | { status: "ready"; src: string };

function isDangerousIframeSrc(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol !== "http:" && protocol !== "https:";
  } catch {
    return false;
  }
}

export function BrowserPanel({ params }: { params: BrowserPanelParams }) {
  const isExternal = params.kind === "external";
  const { projects, projectUrls, refreshProjectUrls } = useDashboardStore();
  const project = isExternal ? undefined : projects.find((p) => p.id === params.projectId);
  const projectId = project?.id;
  const devServerUrl = project?.devServerUrl;
  const detectedDevServerPort = project?.detectedDevServerPort;

  const [fetchState, setFetchState] = useState<BrowserPanelState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [currentUrl, setCurrentUrl] = useState(params.url ?? "");
  const [addressInput, setAddressInput] = useState(params.url ?? "");
  const [savedUrl, setSavedUrl] = useState<string | null>(null);
  const [savedUrlLabel, setSavedUrlLabel] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const savedUrls = projectId ? (projectUrls[projectId] ?? []) : [];

  useEffect(() => {
    if (projectId) void refreshProjectUrls(projectId);
  }, [projectId, refreshProjectUrls]);

  useEffect(() => {
    if (isExternal && savedUrl) return;
    if (isExternal && !currentUrl) return;
    if (!isExternal && !savedUrl && !devServerUrl) return;
    if (!isExternal && savedUrl) return;

    let cancelled = false;
    api
      .getServerInfo()
      .then((info) => {
        if (cancelled) return;
        if (!info.previewsEnabled || !info.previewBaseHost) {
          const directUrl = isExternal ? currentUrl : devServerUrl;
          if (directUrl && isDangerousIframeSrc(directUrl)) {
            setFetchState({
              status: "unavailable",
              message: "This URL's scheme can't be previewed here.",
            });
            return;
          }
          if (directUrl) {
            setFetchState({ status: "ready", src: directUrl });
          }
          return;
        }
        const previewPromise =
          isExternal && currentUrl === params.url && params.slug
            ? Promise.resolve({ slug: params.slug })
            : isExternal
              ? api.createExternalPreview(currentUrl)
              : api.createProjectPreview(projectId!);
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
  }, [
    isExternal,
    currentUrl,
    params.url,
    params.slug,
    projectId,
    devServerUrl,
    reloadKey,
    savedUrl,
  ]);

  const navigateToSavedUrl = (url: string, label: string) => {
    setSavedUrl(url);
    setSavedUrlLabel(label);
    setDropdownOpen(false);
    if (isDangerousIframeSrc(url)) {
      setFetchState({
        status: "unavailable",
        message: "This URL's scheme can't be previewed here.",
      });
      return;
    }
    api
      .getServerInfo()
      .then((info) => {
        if (!info.previewsEnabled || !info.previewBaseHost) {
          setFetchState({ status: "ready", src: url });
          return;
        }
        return api.createExternalPreview(url).then((preview) => {
          const scheme = window.location.protocol;
          setFetchState({
            status: "ready",
            src: `${scheme}//preview-${preview.slug}.${info.previewBaseHost}/`,
          });
        });
      })
      .catch((err: unknown) => {
        setFetchState({
          status: "unavailable",
          message: err instanceof ApiError ? err.message : "Couldn't open this URL.",
        });
      });
  };

  const navigateToDevServer = () => {
    setSavedUrl(null);
    setSavedUrlLabel(null);
    setDropdownOpen(false);
    setReloadKey((k) => k + 1);
  };

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    if (dropdownOpen) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [dropdownOpen]);

  const state: BrowserPanelState =
    !isExternal && !savedUrl && !devServerUrl
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
    setSavedUrl(null);
    setSavedUrlLabel(null);
    setCurrentUrl(trimmed);
  };

  if (!isExternal) {
    if (state.status === "loading" || state.status === "empty") {
      return <div className="browser-panel-empty">Loading…</div>;
    }
    if (state.status === "unavailable") {
      return <div className="browser-panel-empty">{state.message}</div>;
    }
    const currentLabel = savedUrlLabel ?? "Dev server";
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
                  className={`browser-panel-dropdown-item${!savedUrl ? " active" : ""}`}
                  onClick={navigateToDevServer}
                >
                  Dev server
                </button>
                {savedUrls.length > 0 && <div className="browser-panel-dropdown-separator" />}
                {savedUrls.map((u) => (
                  <button
                    key={u.id}
                    className={`browser-panel-dropdown-item${savedUrl === u.url ? " active" : ""}`}
                    onClick={() => navigateToSavedUrl(u.url, u.label)}
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
            {savedUrl ?? devServerUrl ?? ""}
          </span>
          <button
            className="browser-panel-reload"
            onClick={() => setReloadKey((k) => k + 1)}
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
        <input
          className="browser-panel-address mono"
          value={addressInput}
          onChange={(e) => setAddressInput(e.target.value)}
          placeholder="https://example.com"
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
