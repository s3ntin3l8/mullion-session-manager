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
      <Row label="Theme" desc="Mullion is dark-first. System follows your OS." align="start">
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
      <Row label="Sidebar density" desc="Row height for the workspace & project tree.">
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
        label="Layout"
        desc="Auto picks phone/tablet/desktop from window width. Override it if a foldable device reports ambiguous metrics, or to test a tier from a desktop browser."
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
          desc="How many sessions tile side by side before a new one docks as a tab instead. 3 gives each column less width, which trips the narrow-pane font shrink sooner — 2 is the safer default unless your unfolded/tablet width is comfortably wide."
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
