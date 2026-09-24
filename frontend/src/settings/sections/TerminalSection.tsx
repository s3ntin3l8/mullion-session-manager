import { useDashboardStore } from "../../store/index.js";
import {
  Dropdown,
  GroupHeading,
  NumberField,
  Row,
  Segmented,
  Slider,
  Toggle,
} from "../../ui/primitives.js";
import { SwatchGrid, TerminalPreview } from "../TerminalPreview.js";

const FONT_FAMILY_OPTIONS = [
  { value: "Geist Mono", label: "Geist Mono" },
  { value: "JetBrains Mono", label: "JetBrains Mono" },
  { value: "SF Mono", label: "SF Mono" },
  { value: "Menlo", label: "Menlo" },
  { value: "IBM Plex Mono", label: "IBM Plex Mono" },
];

export function TerminalSection() {
  const { settings, updateSettings, theme } = useDashboardStore();
  const t = settings.terminal;
  return (
    <>
      <Row label="Font" desc="Typeface used in terminal panes." align="start">
        <Dropdown
          value={t.fontFamily}
          onChange={(v) => updateSettings({ terminal: { fontFamily: v } })}
          options={FONT_FAMILY_OPTIONS}
        />
      </Row>
      <Row label="Font size" desc="Text size in terminal panes.">
        <Slider
          min={10}
          max={20}
          value={t.fontSize}
          format={(v) => `${v}px`}
          onChange={(v) => updateSettings({ terminal: { fontSize: v } })}
        />
      </Row>
      <Row label="Pane padding" desc="Space between the pane edge and the terminal text.">
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

      <Row label="Cursor style" desc="Shape of the terminal cursor.">
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
      <Row label="Cursor blink" desc="Blink the cursor in the focused pane.">
        <Toggle
          on={t.cursorBlink}
          onChange={(v) => updateSettings({ terminal: { cursorBlink: v } })}
        />
      </Row>

      <div style={{ paddingTop: 6 }}>
        <GroupHeading title="Behavior" />
      </div>
      <Row label="Scrollback" desc="Lines of history kept per pane.">
        <NumberField
          value={t.scrollback}
          min={100}
          max={100000}
          suffix="lines"
          onChange={(v) => updateSettings({ terminal: { scrollback: v } })}
        />
      </Row>
      <Row label="Auto-reconnect" desc="Reconnect automatically when the connection drops.">
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <NumberField
            value={t.reconnect.maxAttempts}
            min={1}
            max={20}
            width={42}
            suffix="max"
            onChange={(v) => updateSettings({ terminal: { reconnect: { maxAttempts: v } } })}
          />
          <Toggle
            on={t.reconnect.enabled}
            onChange={(v) => updateSettings({ terminal: { reconnect: { enabled: v } } })}
          />
        </div>
      </Row>
    </>
  );
}
