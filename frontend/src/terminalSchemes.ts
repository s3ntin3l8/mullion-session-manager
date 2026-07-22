// The six terminal color-scheme palettes from the reference design
// (SettingsBody.dc.html's `data-schemes` swatch grid + live preview), ported
// verbatim including hex values. Deliberately terminal-only — the app
// chrome keeps its existing dark/light `--fg`/`--bg`/etc. tokens
// (styles.css); a scheme here only ever feeds `buildXtermTheme` (see
// terminalTheme.ts) and the Appearance section's swatch/preview UI.
export interface TerminalScheme {
  id: string;
  name: string;
  bg: string;
  fg: string;
  bgLight: string;
  fgLight: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  red: string;
}

export const TERMINAL_SCHEMES: TerminalScheme[] = [
  {
    id: "default",
    name: "Mullion Dark",
    bg: "#0d0d0d",
    fg: "#ededed",
    bgLight: "#f0f0f0",
    fgLight: "#1c1c1e",
    green: "#5ec27a",
    yellow: "#d7b06a",
    blue: "#5c9bf5",
    magenta: "#b884db",
    cyan: "#43c1c1",
    red: "#e5575a",
  },
  {
    id: "tokyonight",
    name: "Tokyo Night",
    bg: "#1a1b26",
    fg: "#c0caf5",
    bgLight: "#e8e6df",
    fgLight: "#1e1e2e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    red: "#f7768e",
  },
  {
    id: "dracula",
    name: "Dracula",
    bg: "#282a36",
    fg: "#f8f8f2",
    bgLight: "#f0edf2",
    fgLight: "#1e1e2e",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    red: "#ff5555",
  },
  {
    id: "solarized",
    name: "Solarized",
    bg: "#002b36",
    fg: "#93a1a1",
    bgLight: "#fdf6e3",
    fgLight: "#657b83",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    red: "#dc322f",
  },
  {
    id: "gruvbox",
    name: "Gruvbox",
    bg: "#282828",
    fg: "#ebdbb2",
    bgLight: "#fbf1c7",
    fgLight: "#3c3836",
    green: "#b8bb26",
    yellow: "#fabd2f",
    blue: "#83a598",
    magenta: "#d3869b",
    cyan: "#8ec07c",
    red: "#fb4934",
  },
  {
    id: "onedark",
    name: "One Dark",
    bg: "#282c34",
    fg: "#abb2bf",
    bgLight: "#eef0f2",
    fgLight: "#2c323c",
    green: "#98c379",
    yellow: "#e5c07b",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    red: "#e06c75",
  },
];

export const DEFAULT_TERMINAL_SCHEME_ID = "default";

export function getTerminalScheme(id: string): TerminalScheme {
  return TERMINAL_SCHEMES.find((s) => s.id === id) ?? TERMINAL_SCHEMES[0];
}
