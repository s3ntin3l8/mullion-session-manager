import { DEFAULT_VOICE_CHORD } from "../../api/index.js";
import { useDashboardStore } from "../../store/index.js";
import { Dropdown, Eyebrow, ListRow, Row, StyledList, Toggle } from "../../ui/primitives.js";
import { KeyChordField } from "../KeyChordField.js";

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

export function InputSection() {
  const { settings, updateSettings } = useDashboardStore();
  const t = settings.terminal;
  return (
    <>
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
        desc="Let terminal programs copy to your clipboard, for example Claude Code's copy command."
      >
        <Toggle
          on={t.clipboardWrite}
          onChange={(v) => updateSettings({ terminal: { clipboardWrite: v } })}
        />
      </Row>

      <Eyebrow
        title="Key-conflict handling"
        desc="When on, the terminal receives the shortcut instead of the browser."
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
        desc="Optional shortcuts for copy and paste. Ctrl+Insert and Shift+Insert (Cmd+C and Cmd+V on macOS) always work."
      />
      <StyledList>
        <ListRow
          title={<span className="settings-kbd-chip">Ctrl + V</span>}
          subtitle="Paste. Replaces the terminal's own use of Ctrl+V (for example, Visual Block in Vim)."
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
          subtitle="Copy the selection. Still interrupts the running program when nothing is selected."
          trailing={
            <Toggle
              size="small"
              on={t.clipboardKeys.ctrlC}
              onChange={(v) => updateSettings({ terminal: { clipboardKeys: { ctrlC: v } } })}
            />
          }
        />
      </StyledList>

      <Eyebrow
        title="Voice dictation"
        desc="Talk instead of typing. Your words are inserted into the prompt, never sent automatically. Requires HTTPS and a browser with speech recognition (not available in Firefox)."
      />
      <Row label="Enable dictation" desc="Show a microphone button in terminal panes.">
        <Toggle
          on={t.voice.enabled}
          onChange={(v) => updateSettings({ terminal: { voice: { enabled: v } } })}
          ariaLabel="Enable dictation"
        />
      </Row>
      <Row
        label="Dictation hotkey"
        desc="Hold a key combination to talk, instead of using the microphone button."
      >
        <Toggle
          on={t.voice.hotkeyEnabled}
          onChange={(v) => updateSettings({ terminal: { voice: { hotkeyEnabled: v } } })}
          ariaLabel="Dictation hotkey"
        />
      </Row>
      <Row label="Hotkey" desc="Click, then press the key combination you want to use.">
        <KeyChordField
          value={t.voice.hotkey}
          defaultValue={DEFAULT_VOICE_CHORD}
          onChange={(hotkey) => updateSettings({ terminal: { voice: { hotkey } } })}
          disabled={!t.voice.hotkeyEnabled}
        />
      </Row>
      <Row label="Dictation language" desc="The language you speak.">
        <Dropdown
          options={DICTATION_LANGUAGES}
          value={t.voice.lang}
          onChange={(v) => updateSettings({ terminal: { voice: { lang: v } } })}
        />
      </Row>
    </>
  );
}
