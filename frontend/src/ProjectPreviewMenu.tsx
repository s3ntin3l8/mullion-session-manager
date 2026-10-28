import { useEffect, useState } from "react";
import { api } from "./api/index.js";
import type { ProjectPreviewConfig } from "./api/index.js";
import { useDashboardStore } from "./store/index.js";
import { KebabMenu } from "./ui/KebabMenu.js";
import type { KebabMenuItem } from "./ui/KebabMenu.js";
import { Modal } from "./ui/Modal.js";

function usePreviewConfig(projectId: number) {
  const config = useDashboardStore((s) => s.projectPreviewConfigs[projectId]);
  const refresh = useDashboardStore((s) => s.refreshProjectPreviewConfig);
  const defaultUrl = useDashboardStore(
    (s) => s.projects.find((p) => p.id === projectId)?.devServerUrl,
  );
  const [error, setError] = useState(false);
  useEffect(() => {
    // Reuse the per-project cache; saves refresh it. Edits in another tab
    // become visible on reload rather than causing a fetch for every Dock mount.
    if (config) return;
    let cancelled = false;
    void refresh(projectId).catch(() => {
      if (!cancelled) setError(true);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, refresh, config]);
  return {
    config: config && {
      ...config,
      devServerUrl: defaultUrl === undefined ? config.devServerUrl : defaultUrl,
    },
    error,
    retry: () => {
      setError(false);
      void refresh(projectId).catch(() => setError(true));
    },
  };
}

function choices(
  projectId: number,
  config: ProjectPreviewConfig | undefined,
  onOpenDefault: () => void,
  onOpened?: () => void,
): KebabMenuItem[] {
  return [
    ...(config?.devServerUrl
      ? [
          {
            key: "default",
            label: `Dev server — ${config.devServerUrl}`,
            onClick: () => {
              onOpened?.();
              onOpenDefault();
            },
          },
        ]
      : []),
    ...(config?.targets ?? []).map((target) => ({
      key: target.id,
      label: `${target.name} — ${target.destination}`,
      onClick: () => {
        void api
          .createTargetPreview(projectId, target.id)
          .then((preview) => {
            onOpened?.();
            useDashboardStore.getState().requestOpenPreview({
              projectId,
              slug: preview.slug,
              branch: null,
              targetName: target.name,
            });
          })
          .catch((err: unknown) =>
            useDashboardStore
              .getState()
              .reportError(
                "Could not open preview",
                err instanceof Error ? err.message : String(err),
              ),
          );
      },
    })),
  ];
}

export function ProjectPreviewMenu({
  projectId,
  onOpenDefault,
  onBlank,
  onManage,
}: {
  projectId: number;
  onOpenDefault: () => void;
  onBlank?: () => void;
  onManage: () => void;
}) {
  const { config, error, retry } = usePreviewConfig(projectId);
  const items = choices(projectId, config, onOpenDefault);
  if (!config)
    items.push({
      key: "loading",
      label: error ? "Could not load targets — retry" : "Loading targets…",
      disabled: !error,
      onClick: retry,
    });
  else if (!items.length)
    items.push({
      key: "empty",
      label: "No preview targets configured",
      disabled: true,
      onClick: () => {},
    });
  if (onBlank)
    items.push({ key: "blank", label: "New preview tab", opensOverlay: true, onClick: onBlank });
  items.push({ key: "manage", label: "Manage previews…", opensOverlay: true, onClick: onManage });
  return (
    <div className="project-preview-menu">
      <KebabMenu
        title="Preview"
        trigger={<>Preview ▾</>}
        menuPlacement="top"
        menuAlign="left"
        items={items}
      />
    </div>
  );
}

function PickerBody({
  projectId,
  onOpenDefault,
  onBlank,
  onManage,
}: {
  projectId: number;
  onOpenDefault: (id: number) => void;
  onBlank: () => void;
  onManage: (id: number) => void;
}) {
  const { config, error, retry } = usePreviewConfig(projectId);
  const close = () => useDashboardStore.getState().requestPreviewPicker(null);
  const items = choices(projectId, config, () => onOpenDefault(projectId), close);
  const name = useDashboardStore(
    (s) => s.projects.find((p) => p.id === projectId)?.name ?? "project",
  );
  return (
    <Modal title={`Preview — ${name}`} onClose={close}>
      <div className="preview-picker-list">
        {!config &&
          (error ? (
            <button onClick={retry}>Could not load targets — retry</button>
          ) : (
            <p>Loading targets…</p>
          ))}
        {config && !items.length && <p>No preview targets configured.</p>}
        {items.map((item) => (
          <button key={item.key} onClick={item.onClick}>
            {item.label}
          </button>
        ))}
        <button
          onClick={() => {
            close();
            onBlank();
          }}
        >
          New preview tab
        </button>
        <button
          onClick={() => {
            close();
            onManage(projectId);
          }}
        >
          Manage previews…
        </button>
      </div>
    </Modal>
  );
}

export function ProjectPreviewPicker(props: {
  onOpenDefault: (id: number) => void;
  onBlank: () => void;
  onManage: (id: number) => void;
}) {
  const id = useDashboardStore((s) => s.previewPickerProjectId);
  return id === null ? null : <PickerBody key={id} projectId={id} {...props} />;
}
