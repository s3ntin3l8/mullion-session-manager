import { describe, it, expect } from "vitest";
import { buildXtermTheme, getSchemeBackground, BRIGHT_BLACK } from "./terminalTheme.js";

describe("buildXtermTheme", () => {
  it("uses the scheme's dark bg/fg when theme is 'dark' (default)", () => {
    const theme = buildXtermTheme("default");
    expect(theme.background).toBe("#0d0d0d");
    expect(theme.foreground).toBe("#ededed");
    expect(theme.cursor).toBe("#ededed");
    expect(theme.cursorAccent).toBe("#0d0d0d");
  });

  it("uses the scheme's light bg/fg when theme is 'light'", () => {
    const theme = buildXtermTheme("default", "light");
    expect(theme.background).toBe("#f0f0f0");
    expect(theme.foreground).toBe("#1c1c1e");
    expect(theme.cursor).toBe("#1c1c1e");
    expect(theme.cursorAccent).toBe("#f0f0f0");
  });

  it("swaps black/white ANSI colors in light mode for readability", () => {
    const dark = buildXtermTheme("default", "dark");
    const light = buildXtermTheme("default", "light");
    // In dark mode: black = near-black, white = light gray
    expect(dark.black).toBe("#1c1c1e");
    expect(dark.white).toBe("#c7c7cc");
    // In light mode: black = light gray, white = near-black (swapped)
    expect(light.black).toBe("#c7c7cc");
    expect(light.white).toBe("#1c1c1e");
  });

  it("keeps brightBlack medium-gray across themes, but resolves brightWhite to fg in light mode", () => {
    const dark = buildXtermTheme("default", "dark");
    const light = buildXtermTheme("default", "light");
    expect(dark.brightBlack).toBe(BRIGHT_BLACK);
    expect(dark.brightWhite).toBe("#ffffff");
    // brightBlack stays medium gray in both modes (visible on both
    // backgrounds); brightWhite would be nearly invisible on a light
    // background, so it resolves to the scheme's light-mode foreground.
    expect(light.brightBlack).toBe(BRIGHT_BLACK);
    expect(light.brightWhite).toBe(light.foreground);
    expect(light.brightWhite).not.toBe("#ffffff");
  });

  it("resolves brightWhite to fgLight for every scheme in light mode", () => {
    const cases: Record<string, string> = {
      default: "#1c1c1e",
      tokyonight: "#1e1e2e",
      dracula: "#1e1e2e",
      solarized: "#657b83",
      gruvbox: "#3c3836",
      onedark: "#2c323c",
    };
    for (const [id, fgLight] of Object.entries(cases)) {
      const theme = buildXtermTheme(id, "light");
      expect(theme.brightWhite).toBe(fgLight);
    }
  });

  it("lightens bright chromatic colors in dark mode but darkens them in light mode", () => {
    const dark = buildXtermTheme("dracula", "dark");
    const light = buildXtermTheme("dracula", "light");

    // Unweighted RGB sum, not real (perceptual) luminance — fine here since
    // this only needs to preserve ordering for a greater-than/less-than
    // comparison, not measure an actual ratio. If this test ever needs to
    // assert a specific contrast ratio, switch to Rec. 709 luma
    // (0.2126R + 0.7152G + 0.0722B) instead.
    const luminance = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return ((n >> 16) & 0xff) + ((n >> 8) & 0xff) + (n & 0xff);
    };

    const pairs: Array<[keyof typeof dark, string]> = [
      ["brightRed", "#ff5555"],
      ["brightGreen", "#50fa7b"],
      ["brightYellow", "#f1fa8c"],
      ["brightBlue", "#bd93f9"],
      ["brightMagenta", "#ff79c6"],
      ["brightCyan", "#8be9fd"],
    ];
    for (const [brightKey, base] of pairs) {
      expect(luminance(dark[brightKey] as string)).toBeGreaterThan(luminance(base));
      expect(luminance(light[brightKey] as string)).toBeLessThan(luminance(base));
    }
  });

  it("keeps ANSI color palette (red, green, etc.) unchanged across themes", () => {
    const dark = buildXtermTheme("default", "dark");
    const light = buildXtermTheme("default", "light");
    expect(dark.red).toBe("#e5575a");
    expect(light.red).toBe("#e5575a");
    expect(dark.green).toBe("#5ec27a");
    expect(light.green).toBe("#5ec27a");
    expect(dark.blue).toBe("#5c9bf5");
    expect(light.blue).toBe("#5c9bf5");
    expect(dark.yellow).toBe("#d7b06a");
    expect(light.yellow).toBe("#d7b06a");
  });

  it("uses correct light bg/fg for each scheme", () => {
    const cases: Record<string, { bg: string; fg: string }> = {
      default: { bg: "#f0f0f0", fg: "#1c1c1e" },
      tokyonight: { bg: "#e8e6df", fg: "#1e1e2e" },
      dracula: { bg: "#f0edf2", fg: "#1e1e2e" },
      solarized: { bg: "#fdf6e3", fg: "#657b83" },
      gruvbox: { bg: "#fbf1c7", fg: "#3c3836" },
      onedark: { bg: "#eef0f2", fg: "#2c323c" },
    };
    for (const [id, expected] of Object.entries(cases)) {
      const theme = buildXtermTheme(id, "light");
      expect(theme.background).toBe(expected.bg);
      expect(theme.foreground).toBe(expected.fg);
    }
  });

  it("falls back to the first scheme for an unknown scheme id", () => {
    const dark = buildXtermTheme("nonexistent");
    expect(dark.background).toBe("#0d0d0d");
    expect(dark.foreground).toBe("#ededed");

    const light = buildXtermTheme("nonexistent", "light");
    expect(light.background).toBe("#f0f0f0");
    expect(light.foreground).toBe("#1c1c1e");
  });

  it("produces a distinct light cursorAccent (same as background)", () => {
    // Cursor accent should match the background in both modes
    const dark = buildXtermTheme("solarized", "dark");
    expect(dark.cursorAccent).toBe(dark.background);
    const light = buildXtermTheme("solarized", "light");
    expect(light.cursorAccent).toBe(light.background);
  });

  it("selectionBackground always uses the scheme's blue", () => {
    const dark = buildXtermTheme("solarized", "dark");
    expect(dark.selectionBackground).toBe("#268bd24D");
    const light = buildXtermTheme("solarized", "light");
    expect(light.selectionBackground).toBe("#268bd24D");
  });
});

describe("getSchemeBackground", () => {
  it("matches buildXtermTheme's background for every scheme and theme", () => {
    for (const id of ["default", "tokyonight", "dracula", "solarized", "gruvbox", "onedark"]) {
      for (const theme of ["dark", "light"] as const) {
        expect(getSchemeBackground(id, theme)).toBe(buildXtermTheme(id, theme).background);
      }
    }
  });

  it("defaults to the dark background when theme is omitted", () => {
    expect(getSchemeBackground("dracula")).toBe("#282a36");
  });

  it("falls back to the first scheme for an unknown scheme id", () => {
    expect(getSchemeBackground("nonexistent", "dark")).toBe("#0d0d0d");
    expect(getSchemeBackground("nonexistent", "light")).toBe("#f0f0f0");
  });
});
