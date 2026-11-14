import { SidebarDevices } from "../SidebarDevices.js";
import { SidebarHeader } from "./SidebarHeader.js";
import { VIEW_TITLES } from "./viewTitles.js";
import type { RightSidebarViewProps } from "./views.js";

// The right sidebar's Devices view: the device list with start, stop and open.
// Host-global (the registry marks it `hostGlobal`), so `projectId` is unused.
// The list, its polling and its error handling are SidebarDevices — the same
// component the phone navigator's Devices tab renders — not a second copy.
//
// Opening a device's screen is `actions.onOpenDevice`: a grid pane, as it has
// always been. A later slice (the two-halves layout, #3012) shows the screen
// inside this view instead; that hooks in right here, by choosing between
// showing the screen in place and calling `actions.onOpenDevice`.
export function DevicesSidebarView({ actions }: RightSidebarViewProps) {
  return (
    <div className="devices-sidebar-view">
      <SidebarHeader label={VIEW_TITLES.devices} />
      <SidebarDevices
        showHeader={false}
        onOpenDevice={actions.onOpenDevice}
        empty={
          <div className="github-panel-empty-row">
            No devices yet. Create one in Settings → Devices.
          </div>
        }
      />
    </div>
  );
}
