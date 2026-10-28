import { useEffect } from "react";
import { settingsApi } from "../api/settings.js";
import { buildXtermTheme } from "../terminalTheme.js";

// Reports the terminal palette this dashboard resolved for the current theme
// and color scheme, so the backend can answer a program's startup color query
// (OSC 11 + DA1) while no pane is attached yet — see
// src/services/terminal-query-reply.ts for why a late answer from the browser
// is too late for Codex. Waits for the settings fetch so the seeded defaults
// are never reported, and re-reports on a theme or scheme change.
const HEX = /^#[0-9a-fA-F]{6}$/;

export function useReportTerminalPalette(opts: {
  settingsLoaded: boolean;
  colorScheme: string;
  theme: "dark" | "light";
}): void {
  const { settingsLoaded, colorScheme, theme } = opts;
  useEffect(() => {
    if (!settingsLoaded) return;
    const xterm = buildXtermTheme(colorScheme, theme);
    const { foreground, background, cursor } = xterm;
    if (!HEX.test(foreground ?? "") || !HEX.test(background ?? "") || !HEX.test(cursor ?? "")) {
      return;
    }
    // Best effort: a failure just leaves the backend answering nothing, which
    // is the behaviour without this report.
    void settingsApi
      .putTerminalPalette({
        foreground: foreground!,
        background: background!,
        cursor: cursor!,
      })
      .catch(() => {});
  }, [settingsLoaded, colorScheme, theme]);
}
