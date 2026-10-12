import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";

/** Picks a syntax mode from a file's basename; `null` = plain text. `.env`
 * and `.env.*` use the properties mode (KEY=value, # comments). */
export function languageForFile(fileName: string): Extension | null {
  const base = fileName.split("/").pop() ?? fileName;
  const lower = base.toLowerCase();
  if (lower === ".env" || lower.startsWith(".env.") || lower.endsWith(".env")) {
    return StreamLanguage.define(properties);
  }
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  switch (ext) {
    case "properties":
    case "ini":
    case "cfg":
    case "conf":
      return StreamLanguage.define(properties);
    case "sh":
    case "bash":
    case "zsh":
      return StreamLanguage.define(shell);
    case "toml":
      return StreamLanguage.define(toml);
    case "yml":
    case "yaml":
      return StreamLanguage.define(yaml);
    case "json":
    case "jsonc":
      return json();
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return javascript({ jsx: true });
    case "ts":
    case "mts":
    case "cts":
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "md":
    case "markdown":
      return markdown();
    default:
      return null;
  }
}
