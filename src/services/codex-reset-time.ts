// #2940 — Codex states a quota reset in prose ("try again at Nov 4th, 2026
// 3:39 AM"), not a structured field. A time-only phrase, an unparseable
// one, or a time that is already past is not a hold: the caller keeps the
// task on the grace path instead of parking it.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const DATED =
  /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:st|nd|rd|th)?,\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i;

const ISO = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)$/;

/**
 * The future instant a Codex rate-limit message says to retry, or null.
 * A zoneless date is the host's local time. `now` is injectable for tests.
 */
export function parseCodexResetTime(
  message: string | null | undefined,
  now = new Date(),
): Date | null {
  if (typeof message !== "string") return null;
  const extracted = message.match(/try again at\s+(.+?)\s*$/i);
  if (!extracted) return null;
  const raw = extracted[1].trim().replace(/\.$/, "");

  const dated = raw.match(DATED);
  const parsed = dated ? parseDated(dated) : parseIso(raw);
  if (parsed === null || parsed.getTime() <= now.getTime()) return null;
  return parsed;
}

function parseDated(dated: RegExpMatchArray): Date | null {
  const month = MONTHS.indexOf(dated[1].toLowerCase());
  const day = Number(dated[2]);
  const year = Number(dated[3]);
  let hour = Number(dated[4]);
  const minute = Number(dated[5]);
  const ampm = dated[6].toUpperCase();
  if (month < 0 || hour < 1 || hour > 12 || minute > 59) return null;
  if (ampm === "AM") {
    if (hour === 12) hour = 0;
  } else if (hour !== 12) {
    hour += 12;
  }
  const date = new Date(year, month, day, hour, minute, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day)
    return null;
  return date;
}

function parseIso(raw: string): Date | null {
  const iso = raw.match(ISO);
  if (!iso) return null;
  const date = new Date(iso[1]);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}
