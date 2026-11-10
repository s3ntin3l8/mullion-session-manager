// The terminal palette this dashboard last resolved for its theme and color
// scheme (set by hooks/useReportTerminalPalette.ts). POST /api/sessions sends
// it so the new session's startup color query is answered with THIS
// dashboard's colors, not whichever dashboard reported last (#2528).
export interface ReportedPalette {
  foreground: string;
  background: string;
  cursor: string;
}

let current: ReportedPalette | undefined;

export function setReportedPalette(palette: ReportedPalette | undefined): void {
  current = palette;
}

export function getReportedPalette(): ReportedPalette | undefined {
  return current;
}
