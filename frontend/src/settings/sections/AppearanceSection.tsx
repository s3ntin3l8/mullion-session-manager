import { useDashboardStore } from "../../store.js";
import { Dropdown, GroupHeading, Row, Segmented, Slider, Toggle } from "../../ui/primitives.js";
import { SwatchGrid, TerminalPreview } from "../TerminalPreview.js";

const FONT_FAMILY_OPTIONS = [
  { value: "Geist Mono", label: "Geist Mono" },
  { value: "JetBrains Mono", label: "JetBrains Mono" },
  { value: "SF Mono", label: "SF Mono" },
  { value: "Menlo", label: "Menlo" },
  { value: "IBM Plex Mono", label: "IBM Plex Mono" },
];

export function AppearanceSection() {
  const { settings, updateSettings, theme } = useDashboardStore();
  const t = settings.terminal;
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
      <Row label="Terminal font" desc="Applies to xterm rendering." align="start">
        <Dropdown
          value={t.fontFamily}
          onChange={(v) => updateSettings({ terminal: { fontFamily: v } })}
          options={FONT_FAMILY_OPTIONS}
        />
      </Row>
      <Row label="Font size" desc="Terminal glyph size in pixels.">
        <Slider
          min={10}
          max={20}
          value={t.fontSize}
          format={(v) => `${v}px`}
          onChange={(v) => updateSettings({ terminal: { fontSize: v } })}
        />
      </Row>
      <Row label="Pane padding" desc="Inset between the panel edge and terminal content.">
        <Slider
          min={0}
          max={16}
          value={t.padding}
          format={(v) => `${v}px`}
          onChange={(v) => updateSettings({ terminal: { padding: v } })}
        />
      </Row>

      <div style={{ paddingTop: 6 }}>
        <GroupHeading title="Color scheme" />
        <SwatchGrid
          value={t.colorScheme}
          onChange={(v) => updateSettings({ terminal: { colorScheme: v } })}
          theme={theme}
        />
        <TerminalPreview
          schemeId={t.colorScheme}
          fontFamily={t.fontFamily}
          fontSize={t.fontSize}
          cursorStyle={t.cursorStyle}
          theme={theme}
        />
      </div>

      <Row label="Cursor style" desc="Shape of the terminal caret.">
        <Segmented
          value={t.cursorStyle}
          onChange={(v) => updateSettings({ terminal: { cursorStyle: v } })}
          options={[
            { value: "block", label: "Block" },
            { value: "bar", label: "Bar" },
            { value: "underline", label: "Underline" },
          ]}
        />
      </Row>
      <Row label="Cursor blink" desc="Blink the caret when a pane is focused.">
        <Toggle
          on={t.cursorBlink}
          onChange={(v) => updateSettings({ terminal: { cursorBlink: v } })}
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
    </>
  );
}
