import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";

// The legacy properties mode names a `KEY=value` line's key "def" and its value
// "quote" — tags CodeEditor's highlight style leaves unstyled (a key reads as
// plain text, a value as nothing at all). Remapping them HERE, onto tags the
// style already colours, keeps the fix scoped to these files rather than
// recolouring every language that uses definition/quote tags.
const propertiesLanguage = () =>
  StreamLanguage.define({
    ...properties,
    tokenTable: { def: t.propertyName, quote: t.string },
  });

/** Picks a syntax mode from a file's basename; `null` = plain text. `.env`
 * and `.env.*` use the properties mode (KEY=value, # comments). */
export function languageForFile(fileName: string): Extension | null {
  const base = fileName.split("/").pop() ?? fileName;
  const lower = base.toLowerCase();
  if (lower === ".env" || lower.startsWith(".env.") || lower.endsWith(".env")) {
    return propertiesLanguage();
  }
  if (
    lower === "dockerfile" ||
    lower.startsWith("dockerfile.") ||
    lower === "containerfile" ||
    lower.startsWith("containerfile.")
  ) {
    return StreamLanguage.define(dockerFile);
  }
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  switch (ext) {
    case "properties":
    case "ini":
    case "cfg":
    case "conf":
      return propertiesLanguage();
    case "dockerfile":
      return StreamLanguage.define(dockerFile);
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
