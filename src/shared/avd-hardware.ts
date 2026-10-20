// AVD create-time hardware sizes. One implementation for the route
// (src/services/avd-manager.ts re-exports it) and the Devices settings
// form, so a bound change can't land on only one side.

const SIZE_TOKEN = /^(\d{1,6})([KMG])?$/i;

const SDCARD_MIN = 16 * 1024 * 1024;
const SDCARD_MAX = 128 * 1024 * 1024 * 1024;
const RAM_MIN_MB = 128;
const RAM_MAX_MB = 16 * 1024;
const DATA_MIN = 64 * 1024 * 1024;
const DATA_MAX = 512 * 1024 * 1024 * 1024;

function sizeToBytes(amount: number, unit: string): number | null {
  const mult = unit === "K" ? 1024 : unit === "M" ? 1024 * 1024 : 1024 * 1024 * 1024;
  const bytes = amount * mult;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

function parseSizeToken(
  raw: string,
): { amount: number; unit: "K" | "M" | "G" | null; bytes: number | null } | null {
  const match = SIZE_TOKEN.exec(raw.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const unit = match[2] ? (match[2].toUpperCase() as "K" | "M" | "G") : null;
  // A bare number has no byte size of its own — callers that require a unit
  // reject it, and RAM treats a bare number as megabytes.
  const bytes = unit === null ? null : sizeToBytes(amount, unit);
  if (unit !== null && bytes === null) return null;
  return { amount, unit, bytes };
}

function within(bytes: number, min: number, max: number): boolean {
  return bytes >= min && bytes <= max;
}

function readOptionalSize(
  raw: unknown,
  field: string,
): { ok: true; value?: string } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "string") return { ok: false, message: `${field} must be a string` };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true };
  return { ok: true, value: trimmed };
}

export function normalizeAvdHardware(input: {
  sdcardSize?: unknown;
  ramSize?: unknown;
  dataPartitionSize?: unknown;
}):
  | { ok: true; value: { sdcardSize?: string; ramSizeMb?: string; dataPartitionSize?: string } }
  | { ok: false; message: string } {
  const value: { sdcardSize?: string; ramSizeMb?: string; dataPartitionSize?: string } = {};

  const sdcard = readOptionalSize(input.sdcardSize, "sdcardSize");
  if (!sdcard.ok) return sdcard;
  if (sdcard.value !== undefined) {
    const parsed = parseSizeToken(sdcard.value);
    const bytes = parsed?.bytes ?? null;
    if (
      !parsed ||
      parsed.unit === null ||
      bytes === null ||
      !within(bytes, SDCARD_MIN, SDCARD_MAX)
    ) {
      return {
        ok: false,
        message: "sdcardSize must be a size like 512M or 2G (16M–128G)",
      };
    }
    value.sdcardSize = `${parsed.amount}${parsed.unit}`;
  }

  const ram = readOptionalSize(input.ramSize, "ramSize");
  if (!ram.ok) return ram;
  if (ram.value !== undefined) {
    const parsed = parseSizeToken(ram.value);
    // config.ini's hw.ramSize is megabytes. A bare number is already MB;
    // `2048M` is the same; `2G` converts. Kilobytes are not a RAM size.
    const mb =
      parsed === null || parsed.unit === "K"
        ? null
        : parsed.unit === null || parsed.unit === "M"
          ? parsed.amount
          : parsed.amount * 1024;
    if (mb === null || !Number.isSafeInteger(mb) || mb < RAM_MIN_MB || mb > RAM_MAX_MB) {
      return {
        ok: false,
        message: "ramSize must be megabytes (128–16384), or a size like 2048M or 2G",
      };
    }
    value.ramSizeMb = String(mb);
  }

  const data = readOptionalSize(input.dataPartitionSize, "dataPartitionSize");
  if (!data.ok) return data;
  if (data.value !== undefined) {
    const parsed = parseSizeToken(data.value);
    const bytes = parsed?.bytes ?? null;
    if (!parsed || parsed.unit === null || bytes === null || !within(bytes, DATA_MIN, DATA_MAX)) {
      return {
        ok: false,
        message: "dataPartitionSize must be a size like 6G or 800M (64M–512G)",
      };
    }
    value.dataPartitionSize = `${parsed.amount}${parsed.unit}`;
  }

  return { ok: true, value };
}
