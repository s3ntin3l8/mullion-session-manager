import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { minimalChange } from "../lib/minimalChange.js";
import { languageForFile } from "../lib/editorLanguage.js";

// Colours come from the app's CSS variables so the editor follows the
// light/dark theme without a second CM theme.
const theme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--fg)",
    backgroundColor: "color-mix(in srgb, var(--fg) 4%, transparent)",
    fontSize: "0.78125rem",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    lineHeight: "1.5",
  },
  ".cm-content": { caretColor: "var(--fg)" },
  ".cm-cursor": { borderLeftColor: "var(--fg)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--dim)",
    border: "none",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--fg) 5%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--muted)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent-solid) 30%, transparent)",
  },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--y) 25%, transparent)" },
});

const highlight = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--dim)", fontStyle: "italic" },
  { tag: [t.keyword, t.operatorKeyword, t.controlKeyword], color: "var(--p)" },
  { tag: [t.string, t.special(t.string)], color: "var(--g)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--o)" },
  { tag: [t.propertyName, t.definition(t.propertyName), t.attributeName], color: "var(--b)" },
  { tag: [t.variableName, t.name], color: "var(--fg)" },
  { tag: [t.typeName, t.className], color: "var(--y)" },
  { tag: [t.heading, t.strong], fontWeight: "bold", color: "var(--b)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: [t.link, t.url], color: "var(--c)", textDecoration: "underline" },
  { tag: t.invalid, color: "var(--r)" },
]);

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  /** File name or path — only its extension/basename picks the syntax mode. */
  fileName?: string;
  readOnly?: boolean;
  /** Moves the cursor to this 1-based line and scrolls it into view. Re-applied
   * when `token` changes, so re-targeting the same line works. */
  revealLine?: { line: number; token: number };
  /** Fired on Mod-s (Ctrl/Cmd+S). */
  onSave?: () => void;
  ariaLabel?: string;
}

/** Thin CodeMirror 6 wrapper: a controlled `value`, `onChange`, Mod-s save.
 * The view is created once per mount; the parent remounts it (via `key`) when
 * switching files so undo history never leaks across files. */
export function CodeEditor({
  value,
  onChange,
  fileName,
  readOnly = false,
  onSave,
  revealLine,
  ariaLabel,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlyCompartment = useRef(new Compartment());
  // Latest callbacks, read from inside the long-lived CM listeners.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
  }, [onChange, onSave]);

  // Mount once. `value`/`fileName`/`readOnly` are the INITIAL values here;
  // later changes are applied by the effects below.
  useEffect(() => {
    if (!hostRef.current) return;
    const language = fileName ? languageForFile(fileName) : null;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          highlightSelectionMatches(),
          syntaxHighlighting(highlight),
          theme,
          EditorView.contentAttributes.of({ "aria-label": ariaLabel ?? "File editor" }),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                onSaveRef.current?.();
                return true;
              },
            },
            ...searchKeymap,
            ...historyKeymap,
            ...defaultKeymap,
            indentWithTab,
          ]),
          ...(language ? [language] : []),
          readOnlyCompartment.current.of([
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current?.(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Mount-once by design — see the comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External value changes (a reload from disk, a revert) update the doc;
  // a change that merely echoes what the user just typed is a no-op.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      // Only what differs, not the whole document: the cursor, the selection
      // and the scroll position survive a reload from disk unless the edit
      // landed on top of them.
      view.dispatch({ changes: minimalChange(current, value) });
    }
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !revealLine) return;
    const line = view.state.doc.line(Math.min(Math.max(revealLine.line, 1), view.state.doc.lines));
    view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
  }, [revealLine]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartment.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  return <div className="code-editor" ref={hostRef} />;
}
