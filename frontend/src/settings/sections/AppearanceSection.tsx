import { useDashboardStore } from "../../store/index.js";
import { GroupHeading, Row, Segmented } from "../../ui/primitives.js";
import { useLayoutTier } from "../../lib/layoutTier.js";

export function AppearanceSection() {
  const { settings, updateSettings } = useDashboardStore();
  // Live-resolved, not just settings.layoutMode itself — "Auto" needs the
  // actual current tier to know whether to show the tabletPaneCap row at
  // all (tablet tier plan, PR 4: "only shown/meaningful once tablet is
  // active").
  const layoutTier = useLayoutTier(settings.layoutMode);
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
      <Row label="Sidebar density" desc="Row height in the workspace and project sidebar.">
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
        desc="Auto chooses a phone, tablet, or desktop layout from the window width. Pick one to override it, for example on a foldable device."
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
      {/* Hermes review — shown whenever tablet is REACHABLE (the live tier
          itself, per `layoutTier`, or "auto", which can resolve to tablet on
          a later resize), not only while it's the tier live right now. A
          desktop-width "auto" user can otherwise never pre-configure this
          without first switching the override to Tablet, which itself
          re-lays-out the workspace just to reach a settings row. */}
      {(layoutTier === "tablet" || settings.layoutMode === "auto") && (
        <Row
          label="Tablet columns"
          desc="How many sessions sit side by side before new ones open as tabs. Use 3 only on wide screens; narrow columns shrink the terminal font."
        >
          <Segmented
            value={String(settings.tabletPaneCap) as "2" | "3"}
            onChange={(v) => updateSettings({ tabletPaneCap: v === "3" ? 3 : 2 })}
            options={[
              { value: "2", label: "2" },
              { value: "3", label: "3" },
            ]}
          />
        </Row>
      )}
    </>
  );
}
