import { useDashboardStore } from "../../store/index.js";
import { GroupHeading, Row, Segmented, Toggle } from "../../ui/primitives.js";

export function AppearanceSection() {
  const { settings, updateSettings } = useDashboardStore();
  return (
    <>
      <Row label="Theme" desc="System follows your operating system's setting." align="start">
        <Segmented
          value={settings.theme}
          onChange={(v) => updateSettings({ theme: v })}
          options={[
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
            { value: "system", label: "System" },
          ]}
        />
      </Row>
      <Row
        label="Sidebar density"
        desc="Row height in the workspace and project sidebar. Compact also hides a session's working/idle status line — attention lines always stay visible."
      >
        <Segmented
          value={settings.sidebarDensity}
          onChange={(v) => updateSettings({ sidebarDensity: v })}
          options={[
            { value: "comfortable", label: "Comfortable" },
            { value: "compact", label: "Compact" },
          ]}
        />
      </Row>

      <div style={{ paddingTop: 6 }}>
        <GroupHeading title="Layout" />
      </div>
      <Row
        label="Layout mode"
        desc="Auto chooses a phone, tablet, or desktop layout from the window width. Pick one to override it, for example on a foldable device. This is a server-wide setting: forcing Phone here makes every device's workspace layout read-only (issue #1426), the same as viewing one at phone width normally."
        align="start"
      >
        <Segmented
          value={settings.layoutMode}
          onChange={(v) => updateSettings({ layoutMode: v })}
          options={[
            { value: "auto", label: "Auto" },
            { value: "phone", label: "Phone" },
            { value: "tablet", label: "Tablet" },
            { value: "desktop", label: "Desktop" },
          ]}
        />
      </Row>
      <Row
        label="Balance panes after dragging"
        desc="When you drag a panel to a pane's edge, even out that row or column, like the split buttons do. Off: the dropped panel takes half of the pane it landed on."
      >
        <Toggle
          on={settings.balancePanesOnDrop}
          onChange={(v) => updateSettings({ balancePanesOnDrop: v })}
        />
      </Row>
    </>
  );
}
