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
const RETRY_DELAYS_MS = [2_000, 6_000, 15_000];

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
    // Best effort, but a transient failure (backend restarting, a rate-limit
    // answer, the gateway mid-login) must not leave the backend without a
    // palette for the whole page lifetime: retry a few times, backing off.
    // Without a palette the backend answers nothing, which is the behaviour
    // without this report at all.
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const report = (attempt: number) => {
      void settingsApi
        .putTerminalPalette({
          foreground: foreground!,
          background: background!,
          cursor: cursor!,
        })
        .catch(() => {
          if (cancelled || attempt >= RETRY_DELAYS_MS.length) return;
          timer = setTimeout(() => report(attempt + 1), RETRY_DELAYS_MS[attempt]);
        });
    };
    report(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [settingsLoaded, colorScheme, theme]);
}
