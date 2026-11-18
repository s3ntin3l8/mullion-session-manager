// Maps a browser `KeyboardEvent.code` to a USB HID Keyboard/Keypad usage code
// (Usage Page 0x07) for the iOS Simulator's `hidKey` control messages.
// Returns `null` for an unmapped key code so the caller sends nothing.

const FIXED_HID_USAGES: Record<string, number> = {
  // Digits
  Digit1: 0x1e,
  Digit2: 0x1f,
  Digit3: 0x20,
  Digit4: 0x21,
  Digit5: 0x22,
  Digit6: 0x23,
  Digit7: 0x24,
  Digit8: 0x25,
  Digit9: 0x26,
  Digit0: 0x27,

  // Numpad digits
  Numpad1: 0x1e,
  Numpad2: 0x1f,
  Numpad3: 0x20,
  Numpad4: 0x21,
  Numpad5: 0x22,
  Numpad6: 0x23,
  Numpad7: 0x24,
  Numpad8: 0x25,
  Numpad9: 0x26,
  Numpad0: 0x27,

  // Editing & whitespace
  Enter: 0x28,
  NumpadEnter: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,

  // Common punctuation
  Minus: 0x2d,
  NumpadSubtract: 0x2d,
  Equal: 0x2e,
  NumpadEqual: 0x2e,
  BracketLeft: 0x2f,
  BracketRight: 0x30,
  Backslash: 0x31,
  IntlBackslash: 0x31,
  Semicolon: 0x33,
  Quote: 0x34,
  Backquote: 0x35,
  Comma: 0x36,
  Period: 0x37,
  NumpadDecimal: 0x37,
  Slash: 0x38,
  NumpadDivide: 0x38,

  // Navigation & arrows
  Insert: 0x49,
  Home: 0x4a,
  PageUp: 0x4b,
  Delete: 0x4c,
  End: 0x4d,
  PageDown: 0x4e,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
};

export function keyboardEventToHidUsage(code: string): number | null {
  if (code.length === 4 && code.startsWith("Key")) {
    const ch = code.charCodeAt(3);
    // 'A' (0x41)..'Z' (0x5a) -> 0x04..0x1d
    if (ch >= 0x41 && ch <= 0x5a) {
      return 0x04 + (ch - 0x41);
    }
  }
  return FIXED_HID_USAGES[code] ?? null;
}
