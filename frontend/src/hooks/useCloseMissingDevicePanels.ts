import { useEffect } from "react";
import type { DockviewApi } from "dockview-react";
import type { Device } from "../api/index.js";

// Extracted from App.tsx (issue #2407). The hook is called at the effect's
// original position so its order among App's other effects is unchanged.
// The effect body, dependency array, and any eslint-disable inside it are
// the original text.

export interface UseCloseMissingDevicePanelsParams {
  devices: Device[];
  devicesLoaded: boolean;
  dockviewApi: DockviewApi | null;
}

export function useCloseMissingDevicePanels({
  devices,
  devicesLoaded,
  dockviewApi,
}: UseCloseMissingDevicePanelsParams): void {
  // Device-panel counterpart of the session sweep in
  // useCloseKilledSessionPanels.ts, for the other half
  // of the "deleted device stays in the list" fix: DELETE now removes the
  // row outright (routes/devices.ts), so a `device-<id>` panel outliving
  // its row would render DevicePane's "this device was deleted" dead end
  // forever. Note this only closes panels for MISSING rows — a STOPPED row
  // is a real, startable device and its panel stays put showing the stopped
  // overlay (DevicePane), the same way stopping never closed the panel
  // before. Gated on devicesLoaded: `devices` starts [] and every device
  // panel would otherwise be closed during the first moments after a
  // reload, before GET /api/devices resolves.
  useEffect(() => {
    if (!dockviewApi || !devicesLoaded) return;
    for (const panel of dockviewApi.panels) {
      const match = panel.id.match(/^device-(\d+)$/);
      if (!match) continue;
      const deviceId = parseInt(match[1], 10);
      if (!devices.some((d) => d.id === deviceId)) {
        dockviewApi.getPanel(panel.id)?.api.close();
      }
    }
  }, [devices, devicesLoaded, dockviewApi]);
}
