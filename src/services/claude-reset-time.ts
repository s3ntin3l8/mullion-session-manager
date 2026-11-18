// #3265 — Claude Code's `StopFailure` hook puts the reset time in prose inside
// `last_assistant_message` (captured live on Claude Code 2.1.326:
// `"You've hit your 5-hour limit · resets 6:30pm (Europe/Berlin)"`), rather than
// a structured timestamp. `parkRateLimitedTask` (#3234) consumes this parser
// to park rate-limited Claude tasks until the reset.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const TIME_ONLY_RE = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i;
const DATED_RE =
  /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?:,?\s+|\s+at\s+)(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i;

export interface ClaudeCodeStopFailurePayload {
  error?: unknown;
  error_details?: unknown;
  last_assistant_message?: unknown;
}

/**
 * Extracts the future reset `Date` from a Claude Code `StopFailure` hook
 * payload or its message string, or `null` when no future reset is present.
 * `now` is injectable for deterministic tests.
 */
export function parseClaudeCodeResetTime(
  input: ClaudeCodeStopFailurePayload | string | null | undefined,
  now = new Date(),
): Date | null {
  const text = extractMessageText(input);
  if (text === null) return null;

  const extracted = text.match(/\bresets\s+(?:at\s+)?(.+?)\s*$/i);
  if (!extracted) return null;

  let raw = extracted[1].trim().replace(/\.$/, "");
  let timeZone: string | null = null;
  const tzMatch = raw.match(/^(.+?)\s*\(([^()]+)\)$/);
  if (tzMatch) {
    raw = tzMatch[1].trim();
    timeZone = tzMatch[2].trim();
    if (!isValidTimeZone(timeZone)) return null;
  }

  const datedMatch = raw.match(DATED_RE);
  if (datedMatch) {
    return resolveDatedReset(datedMatch, timeZone, now);
  }

  const timeMatch = raw.match(TIME_ONLY_RE);
  if (timeMatch) {
    return resolveTimeOnlyReset(timeMatch, timeZone, now);
  }

  return null;
}

function extractMessageText(
  input: ClaudeCodeStopFailurePayload | string | null | undefined,
): string | null {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return null;
  for (const field of [input.last_assistant_message, input.error_details, input.error]) {
    if (typeof field === "string" && field.length > 0) return field;
  }
  return null;
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function parseClockTime(
  hourStr: string,
  minuteStr: string | undefined,
  ampmStr: string | undefined,
): { hour: number; minute: number } | null {
  let hour = Number(hourStr);
  const minute = minuteStr === undefined ? 0 : Number(minuteStr);
  if (minute > 59) return null;

  if (ampmStr) {
    if (hour < 1 || hour > 12) return null;
    const ampm = ampmStr.toUpperCase();
    if (ampm === "AM") {
      if (hour === 12) hour = 0;
    } else if (hour !== 12) {
      hour += 12;
    }
  } else if (hour > 23) {
    return null;
  }

  return { hour, minute };
}

function resolveTimeOnlyReset(
  match: RegExpMatchArray,
  timeZone: string | null,
  now: Date,
): Date | null {
  const clock = parseClockTime(match[1], match[2], match[3]);
  if (!clock) return null;

  const ref = getCalendarParts(now, timeZone);
  let candidate = buildInstant(ref.year, ref.month, ref.day, clock.hour, clock.minute, timeZone);
  if (candidate === null || candidate.getTime() <= now.getTime()) {
    // A time-only reset that is already past today (e.g. "1:30am" at 10pm)
    // refers to tomorrow in the target timezone.
    candidate = buildInstant(
      ref.year,
      ref.month,
      ref.day + 1,
      clock.hour,
      clock.minute,
      timeZone,
      true,
    );
  }
  if (candidate === null || candidate.getTime() <= now.getTime()) return null;
  return candidate;
}

function resolveDatedReset(
  match: RegExpMatchArray,
  timeZone: string | null,
  now: Date,
): Date | null {
  const month = MONTHS.indexOf(match[1].toLowerCase());
  const day = Number(match[2]);
  const clock = parseClockTime(match[4], match[5], match[6]);
  if (month < 0 || !clock) return null;

  const ref = getCalendarParts(now, timeZone);
  let year = match[3] ? Number(match[3]) : ref.year;
  if (!match[3] && month - ref.month < -6) {
    // Handle Dec -> Jan year rollover when the year is omitted.
    year += 1;
  }

  const candidate = buildInstant(year, month, day, clock.hour, clock.minute, timeZone);
  if (candidate === null || candidate.getTime() <= now.getTime()) return null;
  return candidate;
}

interface CalendarParts {
  year: number;
  month: number; // 0-indexed
  day: number;
  hour: number;
  minute: number;
}

function getCalendarParts(date: Date, timeZone: string | null): CalendarParts {
  if (!timeZone) {
    return {
      year: date.getFullYear(),
      month: date.getMonth(),
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
    };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return {
    year: get("year"),
    month: get("month") - 1,
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

function buildInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string | null,
  allowDayOverflow = false,
): Date | null {
  if (!timeZone) {
    const d = new Date(year, month, day, hour, minute, 0, 0);
    if (
      !allowDayOverflow &&
      (d.getFullYear() !== year || d.getMonth() !== month || d.getDate() !== day)
    ) {
      return null;
    }
    return d;
  }

  // Normalize day overflow (e.g. day + 1 at month end) via Date.UTC first.
  const normalized = new Date(Date.UTC(year, month, day, hour, minute, 0, 0));
  if (
    !allowDayOverflow &&
    (normalized.getUTCFullYear() !== year ||
      normalized.getUTCMonth() !== month ||
      normalized.getUTCDate() !== day)
  ) {
    return null;
  }

  const targetY = normalized.getUTCFullYear();
  const targetM = normalized.getUTCMonth();
  const targetD = normalized.getUTCDate();
  const targetUtcMs = normalized.getTime();

  // Two-pass offset refinement handles DST transitions cleanly.
  let utcMs = targetUtcMs;
  for (let i = 0; i < 2; i++) {
    const zoned = getCalendarParts(new Date(utcMs), timeZone);
    const zonedAsUtc = Date.UTC(zoned.year, zoned.month, zoned.day, zoned.hour, zoned.minute, 0, 0);
    utcMs = targetUtcMs - (zonedAsUtc - utcMs);
  }

  const result = new Date(utcMs);
  const verified = getCalendarParts(result, timeZone);
  if (
    verified.year !== targetY ||
    verified.month !== targetM ||
    verified.day !== targetD ||
    verified.hour !== hour ||
    verified.minute !== minute
  ) {
    return null;
  }
  return result;
}
