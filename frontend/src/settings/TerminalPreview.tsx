// Appearance section's swatch grid + live terminal preview — ported from
// SettingsBody.dc.html's `data-schemes` grid and `[data-preview]` block.
// Terminal-only (see terminalSchemes.ts's header comment): selecting a
// swatch here only ever changes settings.terminal.colorScheme, never the
// app chrome's own dark/light tokens.
import type { CursorStyle } from "../api.js";
import type { Theme } from "../store.js";
import { TERMINAL_SCHEMES, getTerminalScheme } from "../terminalSchemes.js";

import { schemeLabel } from "./schemeLabel.js";

export function SwatchGrid({
  value,
  onChange,
  theme,
}: {
  value: string;
  onChange: (id: string) => void;
  theme: Theme;
}) {
  return (
    <div className="settings-swatch-grid">
      {TERMINAL_SCHEMES.map((scheme) => (
        <button
          key={scheme.id}
          className={`settings-swatch${scheme.id === value ? " selected" : ""}`}
          onClick={() => onChange(scheme.id)}
        >
          <span className="settings-swatch-chips">
            <span
              className="settings-swatch-chip"
              style={{ background: theme === "light" ? scheme.bgLight : scheme.bg }}
            />
            <span className="settings-swatch-chip" style={{ background: scheme.green }} />
            <span className="settings-swatch-chip" style={{ background: scheme.blue }} />
            <span className="settings-swatch-chip" style={{ background: scheme.magenta }} />
          </span>
          <span className="settings-swatch-label">{schemeLabel(scheme.name, theme)}</span>
        </button>
      ))}
    </div>
  );
}

const CARET_SHAPE: Record<CursorStyle, React.CSSProperties> = {
  block: { width: 8, height: 15 },
  bar: { width: 2, height: 15 },
  underline: {
    width: 9,
    height: 15,
    background: "transparent",
    borderBottom: "2px solid var(--pfg, currentColor)",
  },
};

export function TerminalPreview({
  schemeId,
  fontFamily,
  fontSize,
  cursorStyle,
  theme,
}: {
  schemeId: string;
  fontFamily: string;
  fontSize: number;
  cursorStyle: CursorStyle;
  theme: Theme;
}) {
  const scheme = getTerminalScheme(schemeId);
  const vars = {
    "--pbg": theme === "light" ? scheme.bgLight : scheme.bg,
    "--pfg": theme === "light" ? scheme.fgLight : scheme.fg,
    "--pg": scheme.green,
    "--py": scheme.yellow,
    "--pb": scheme.blue,
    "--pm": scheme.magenta,
    "--pc": scheme.cyan,
    "--pr": scheme.red,
  } as React.CSSProperties;

  return (
    <div className="settings-terminal-preview">
      <div className="settings-terminal-preview-titlebar">
        <span className="settings-terminal-preview-dot red" />
        <span className="settings-terminal-preview-dot yellow" />
        <span className="settings-terminal-preview-dot green" />
        <span className="settings-terminal-preview-label">live preview</span>
      </div>
      <div
        className="settings-terminal-preview-body"
        style={{ ...vars, fontFamily: `'${fontFamily}', 'Geist Mono', monospace`, fontSize }}
      >
        <div>
          <span style={{ color: "var(--pg)" }}>➜</span>{" "}
          <span style={{ color: "var(--pb)" }}>~/tessera-hq</span>{" "}
          <span style={{ color: "var(--pm)" }}>
            git:(<span style={{ color: "var(--pr)" }}>main</span>)
          </span>{" "}
          bun run dev
        </div>
        <div>
          <span style={{ color: "var(--pc)" }}>◆</span> Next.js 16.1.6 ready in{" "}
          <span style={{ color: "var(--py)" }}>729ms</span>
        </div>
        <div>
          {"  "}➜ Local: <span style={{ color: "var(--pb)" }}>http://localhost:3777</span>
        </div>
        <div>
          <span style={{ color: "var(--pg)" }}>✓</span> compiled{" "}
          <span style={{ color: "var(--py)" }}>app/page.tsx</span> in 142ms
        </div>
        <div>
          {"$ "}
          <span className="settings-caret" style={CARET_SHAPE[cursorStyle]} />
        </div>
      </div>
    </div>
  );
}
