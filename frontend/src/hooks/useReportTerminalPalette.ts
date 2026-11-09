import { useEffect } from "react";
import { settingsApi } from "../api/settings.js";
import { buildXtermTheme } from "../terminalTheme.js";
import { setReportedPalette } from "../lib/reportedPalette.js";

// Reports the terminal palette this dashboard resolved for the current theme
// and color scheme, so the backend can answer a program's startup color query
// (OSC 11 + DA1) while no pane is attached yet — see
// src/services/terminal-query-reply.ts for why a late answer from the browser
// is too late for Codex. Waits for the settings fetch so the seeded defaults
// are never reported, and re-reports on a theme or scheme change.
const HEX = /^#[0-9a-fA-F]{6}$/;
const RETRY_DELAYS_MS = [2_000, 6_000, 15_000];
// A backgrounded dashboard must not keep the shared fallback palette (what a
// session with no creating dashboard is answered from): the one the user
// returns to re-reports. Throttled so tab flicker is not a request storm.
const REFOCUS_MIN_INTERVAL_MS = 5_000;

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
      // Not the previous theme's colors: a new session must not be created with
      // a palette this dashboard no longer shows.
      setReportedPalette(undefined);
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
    setReportedPalette({ foreground: foreground!, background: background!, cursor: cursor! });
    report(0);
    let lastReport = Date.now();
    const onReturn = () => {
      if (
        document.visibilityState === "hidden" ||
        Date.now() - lastReport < REFOCUS_MIN_INTERVAL_MS
      ) {
        return;
      }
      lastReport = Date.now();
      report(0);
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [settingsLoaded, colorScheme, theme]);
}
