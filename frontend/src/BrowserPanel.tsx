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
    if (existingSlug) {
      return { src: `${scheme}//preview-${existingSlug}.${info.previewBaseHost}/` };
    }
    const preview = await api.createExternalPreview(targetUrl);
    return { src: `${scheme}//preview-${preview.slug}.${info.previewBaseHost}/` };
  } catch (err: unknown) {
    return { error: err instanceof ApiError ? err.message : "Couldn't open this URL." };
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
  const [activeSavedUrlId, setActiveSavedUrlId] = useState<number | null>(null);
  const [activeSavedUrlLabel, setActiveSavedUrlLabel] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const savedUrls = projectId ? (projectUrls[projectId] ?? []) : [];

  useEffect(() => {
    if (projectId) void refreshProjectUrls(projectId);
  }, [projectId, refreshProjectUrls]);

  useEffect(() => {
    if (isExternal && activeSavedUrlId !== null) return;
    if (isExternal && !currentUrl) return;
    if (!isExternal && activeSavedUrlId !== null) return;
    if (!isExternal && !devServerUrl) return;

    let cancelled = false;

    if (isExternal) {
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
    }

    api
      .getServerInfo()
      .then((info) => {
        if (cancelled) return;
        if (!info.previewsEnabled || !info.previewBaseHost) {
          setFetchState({ status: "ready", src: devServerUrl! });
          return;
        }
        return api.createProjectPreview(projectId!).then((preview) => {
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
  }, [isExternal, currentUrl, projectId, devServerUrl, reloadKey, activeSavedUrlId]);

  const navigateToSavedUrl = async (id: number, url: string, label: string) => {
    setActiveSavedUrlId(id);
    setActiveSavedUrlLabel(label);
    setDropdownOpen(false);
    setFetchState({ status: "loading" });
    const result = await resolvePreviewUrl(url);
    if ("error" in result) {
      setFetchState({ status: "unavailable", message: result.error });
    } else {
      setFetchState({ status: "ready", src: result.src });
    }
  };

  const navigateToDevServer = () => {
    setActiveSavedUrlId(null);
    setActiveSavedUrlLabel(null);
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

  const navigate = () => {
    const trimmed = addressInput.trim();
    if (!trimmed) return;
    setActiveSavedUrlId(null);
    setActiveSavedUrlLabel(null);
    setCurrentUrl(trimmed);
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
