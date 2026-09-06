import { useDashboardStore } from "../../store/index.js";
import {
  Dropdown,
  Eyebrow,
  ListRow,
  NumberField,
  Row,
  StyledList,
  Toggle,
} from "../../ui/primitives.js";

// Voice dictation language options — a short curated list (the languages
// Claude Code's own /voice dictation documents supporting), plus "Browser
// default" (empty string, falls back to navigator.language at dictation
// start — see voice/useVoiceDictation.ts's resolveLang). Not exhaustive:
// the underlying Web Speech engine accepts any BCP-47 tag, this is just
// what's worth a menu entry rather than free text.
const DICTATION_LANGUAGES: Array<{ value: string; label: string }> = [
  { value: "", label: "Browser default" },
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "de-DE", label: "German" },
  { value: "es-ES", label: "Spanish" },
  { value: "fr-FR", label: "French" },
  { value: "ja-JP", label: "Japanese" },
];

export function TerminalSection() {
  const { settings, updateSettings } = useDashboardStore();
  const t = settings.terminal;
  return (
    <>
      <Row label="Scrollback" desc="Lines of history kept per pane in the browser.">
        <NumberField
          value={t.scrollback}
          min={100}
          max={100000}
          suffix="lines"
          onChange={(v) => updateSettings({ terminal: { scrollback: v } })}
        />
      </Row>
      <Row label="Copy on select" desc="Selecting text copies it to the clipboard.">
        <Toggle
          on={t.copyOnSelect}
          onChange={(v) => updateSettings({ terminal: { copyOnSelect: v } })}
        />
      </Row>
      <Row label="Paste on right-click" desc="Right-click pastes the clipboard into the terminal.">
        <Toggle
          on={t.pasteOnRightClick}
          onChange={(v) => updateSettings({ terminal: { pasteOnRightClick: v } })}
        />
      </Row>
      <Row
        label="Allow programs to set the clipboard"
        desc="Lets the running CLI copy to your clipboard directly (OSC 52) — this is how Claude Code and opencode's own copy commands work."
      >
        <Toggle
          on={t.clipboardWrite}
          onChange={(v) => updateSettings({ terminal: { clipboardWrite: v } })}
        />
      </Row>
      <Row label="Auto-reconnect on drop" desc="Re-attach the socket with exponential backoff.">
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

      <Eyebrow
        title="Voice dictation"
        desc="Push-to-talk into the prompt via the browser's speech engine — transcribed text is inserted, never sent automatically. Needs an https:// origin; hidden automatically in browsers without speech recognition support (Firefox today)."
      />
      <Row label="Enable dictation" desc="Shows the mic button in the terminal pane.">
        <Toggle
          on={t.voice.enabled}
          onChange={(v) => updateSettings({ terminal: { voice: { enabled: v } } })}
          ariaLabel="Enable dictation"
        />
      </Row>
      <Row
        label="Dictation hotkey"
        desc="Hold Ctrl+Shift+Space to talk, as an alternative to the mic button."
      >
        <Toggle
          on={t.voice.hotkeyEnabled}
          onChange={(v) => updateSettings({ terminal: { voice: { hotkeyEnabled: v } } })}
          ariaLabel="Dictation hotkey"
        />
      </Row>
      <Row label="Dictation language" desc="What language you're speaking.">
        <Dropdown
          options={DICTATION_LANGUAGES}
          value={t.voice.lang}
          onChange={(v) => updateSettings({ terminal: { voice: { lang: v } } })}
        />
      </Row>

      <Eyebrow
        title="Key-conflict handling"
        desc="When on, the terminal captures the shortcut instead of the browser."
      />
      <StyledList>
        <ListRow
          title={<span className="settings-kbd-chip">Ctrl + R</span>}
          subtitle="Reverse search"
          trailing={
            <Toggle
              size="small"
              on={t.keyCapture.ctrlR}
              onChange={(v) => updateSettings({ terminal: { keyCapture: { ctrlR: v } } })}
            />
          }
        />
        <ListRow
          title={<span className="settings-kbd-chip">Ctrl + L</span>}
          subtitle="Clear screen"
          trailing={
            <Toggle
              size="small"
              on={t.keyCapture.ctrlL}
              onChange={(v) => updateSettings({ terminal: { keyCapture: { ctrlL: v } } })}
            />
          }
        />
        <ListRow
          title={<span className="settings-kbd-chip">Ctrl + K</span>}
          subtitle="Reserved for command palette"
          trailing={
            <Toggle
              size="small"
              on={t.keyCapture.ctrlK}
              onChange={(v) => updateSettings({ terminal: { keyCapture: { ctrlK: v } } })}
            />
          }
        />
      </StyledList>

      <Eyebrow
        title="Clipboard shortcuts"
        desc="Opt-in chords Mullion handles instead of the terminal. Ctrl+Insert / Shift+Insert (and Cmd+C / Cmd+V on macOS) always work regardless."
      />
      <StyledList>
        <ListRow
          title={<span className="settings-kbd-chip">Ctrl + V</span>}
          subtitle="Paste clipboard — overrides vim Visual Block and readline quoted-insert"
          trailing={
            <Toggle
              size="small"
              on={t.clipboardKeys.ctrlV}
              onChange={(v) => updateSettings({ terminal: { clipboardKeys: { ctrlV: v } } })}
            />
          }
        />
        <ListRow
          title={<span className="settings-kbd-chip">Ctrl + C</span>}
          subtitle="Copy the selection; still sends SIGINT when nothing is selected"
          trailing={
            <Toggle
              size="small"
              on={t.clipboardKeys.ctrlC}
              onChange={(v) => updateSettings({ terminal: { clipboardKeys: { ctrlC: v } } })}
            />
          }
        />
      </StyledList>
    </>
  );
}
