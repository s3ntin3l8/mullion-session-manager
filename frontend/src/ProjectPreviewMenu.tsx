import { useEffect, useState } from "react";
import { api } from "./api/index.js";
import type { Device, NamedPreviewTarget, ProjectPreviewConfig, ServerInfo } from "./api/index.js";
import { buildPreviewSrc, mintPreviewTokenIfRequired } from "./lib/previewSrc.js";
import {
  deviceDevServerRoute,
  deviceTargetRoute,
  isDeviceBooting,
  isOpenableDevice,
} from "./lib/deviceUrl.js";
import type { DeviceRoute } from "./lib/deviceUrl.js";
import { useDashboardStore } from "./store/index.js";
import { KebabMenu } from "./ui/KebabMenu.js";
import type { KebabMenuItem } from "./ui/KebabMenu.js";
import { Modal } from "./ui/Modal.js";
import { Presence } from "./ui/Presence.js";

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

/** Where the project's dev server runs and its address from there, from the
 * same browser-destinations answer the Browser pane uses (it resolves the host
 * from the running Dock control, which is not always the project's own host).
 * Fetched only when a running device (iOS Simulator or Android) exists, and
 * again if the saved dev
 * server or the project's running Dock sessions change. */
function useDevServerDestination(
  projectId: number,
  devices: Device[],
  devServerUrl: string | null | undefined,
): { address: string; hostId: string } | null {
  const hasDevice = devices.some(isOpenableDevice);
  const [found, setFound] = useState<{ key: string; address: string; hostId: string } | null>(null);
  // The dev-server host follows the running Dock control, so starting or
  // stopping one re-resolves it. A primitive, so it only changes with the set.
  const dockSessions = useDashboardStore((s) =>
    s.sessions
      .filter((x) => x.kind === "dock" && x.status === "active" && x.projectId === projectId)
      .map((x) => x.id)
      .join(","),
  );
  const key = `${projectId}:${devServerUrl ?? ""}:${dockSessions}`;
  useEffect(() => {
    if (!hasDevice || !devServerUrl) return;
    let cancelled = false;
    void api
      .getBrowserDestinations(projectId)
      .then((res) => {
        if (cancelled) return;
        const d = res.destinations.find((x) => x.kind === "dev-server");
        setFound(d?.address ? { key, address: d.address, hostId: d.hostId } : null);
      })
      .catch(() => {
        if (!cancelled) setFound(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, devServerUrl, hasDevice, key]);
  return found && found.key === key ? found : null;
}

/** How long a failed server-info read waits before it is retried. */
const SERVER_INFO_RETRY_MS = 10_000;

/** The preview proxy's settings, fetched once a running device exists: a
 * device that cannot reach the dev server's loopback, and every named
 * target, open through the Mullion preview URL. "loading" until the first
 * answer; a failed read reports "failed" (not "previews off") and is retried. */
function usePreviewServerInfo(devices: Device[]): ServerInfo | "loading" | "failed" {
  const hasDevice = devices.some(isOpenableDevice);
  const [info, setInfo] = useState<ServerInfo | "loading" | "failed">("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!hasDevice) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    void api
      .getServerInfo()
      .then((res) => {
        if (!cancelled) setInfo(res);
      })
      .catch(() => {
        if (cancelled) return;
        setInfo("failed");
        retry = setTimeout(() => setAttempt((n) => n + 1), SERVER_INFO_RETRY_MS);
      });
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [hasDevice, attempt]);
  return info;
}

/** Hands a device the entry's Mullion preview URL. With preview auth on it
 * carries a fresh 60-second bootstrap token, minted at click time: the
 * device's browser has no dashboard session, and the proxy trades the token
 * for its own preview cookie on that first load (docs/device-panel.md). */
async function openPreviewOnDevice(
  projectId: number,
  deviceId: number,
  targetId: string | null,
  info: ServerInfo | "loading" | "failed",
): Promise<void> {
  // A "preview" route is only offered once the info is known; never reached.
  if (typeof info === "string") throw new Error("Previews are not enabled on this server");
  const { slug } =
    targetId === null
      ? await api.createProjectPreview(projectId)
      : await api.createTargetPreview(projectId, targetId);
  const token = await mintPreviewTokenIfRequired(info, slug);
  const url = buildPreviewSrc(window.location.protocol, slug, info.previewBaseHost, token);
  await api.openUrlOnDevice(deviceId, url);
}

function deviceRow(
  key: string,
  label: string,
  route: DeviceRoute,
  open: () => Promise<unknown>,
): KebabMenuItem {
  if (route.kind === "unavailable") {
    return { key, label, disabled: true, title: route.reason, onClick: () => {} };
  }
  return {
    key,
    label,
    onClick: () => {
      void open().catch((err: unknown) =>
        useDashboardStore
          .getState()
          .reportError(
            "Could not open on device",
            err instanceof Error ? err.message : String(err),
          ),
      );
    },
  };
}

/** The label suffix of a disabled row, shared by the dev-server and target
 * rows so it agrees with the tooltip's reason: booting first, then "on another
 * host" where the row's route depends on the host, else "unavailable". */
function unavailableSuffix(d: Device, otherHost: boolean): string {
  if (isDeviceBooting(d)) return " (booting)";
  return otherHost ? " (on another host)" : " (unavailable)";
}

/** "Open … on <device>" rows per running iOS Simulator or Android device: the
 * project's dev server, then each named preview target. Manual only; a row the
 * device cannot open is listed disabled with the reason, not hidden. */
function deviceItems(
  projectId: number,
  devServer: { address: string; hostId: string } | null,
  targets: NamedPreviewTarget[],
  devices: Device[],
  info: ServerInfo | "loading" | "failed",
): KebabMenuItem[] {
  return devices.filter(isOpenableDevice).flatMap((d) => {
    const name = d.name ?? `${d.platform === "ios" ? "Simulator" : "Device"} ${d.id}`;
    const rows: KebabMenuItem[] = [];
    if (devServer) {
      const route = deviceDevServerRoute(devServer.address, d, devServer.hostId, info);
      const suffix =
        route.kind === "preview"
          ? " (via preview)"
          : route.kind === "unavailable"
            ? unavailableSuffix(d, d.hostId !== devServer.hostId)
            : "";
      rows.push(
        deviceRow(`device-${d.id}`, `Open dev server on ${name}${suffix}`, route, () =>
          route.kind === "direct"
            ? api.openUrlOnDevice(d.id, route.url)
            : openPreviewOnDevice(projectId, d.id, null, info),
        ),
      );
    }
    for (const target of targets) {
      const route = deviceTargetRoute(d, info);
      rows.push(
        deviceRow(
          `device-${d.id}-${target.id}`,
          `Open ${target.name} on ${name}${route.kind === "unavailable" ? unavailableSuffix(d, false) : ""}`,
          route,
          () => openPreviewOnDevice(projectId, d.id, target.id, info),
        ),
      );
    }
    return rows;
  });
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
  const devices = useDashboardStore((s) => s.devices);
  const devServer = useDevServerDestination(projectId, devices, config?.devServerUrl);
  const serverInfo = usePreviewServerInfo(devices);
  const items = [
    ...choices(projectId, config, onOpenDefault),
    ...deviceItems(projectId, devServer, config?.targets ?? [], devices, serverInfo),
  ];
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
  return (
    <Presence when={id !== null}>
      {id !== null && <PickerBody key={id} projectId={id} {...props} />}
    </Presence>
  );
}
