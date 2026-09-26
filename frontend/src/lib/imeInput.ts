import type { Terminal } from "@xterm/xterm";

// Takes over non-composing soft-keyboard edits from xterm's CompositionHelper.
//
// Android keyboards (Gboard) deliver typing as keyCode-229 keydowns plus
// `beforeinput`/`input` on xterm's hidden helper textarea. xterm then works out
// what to send by diffing the textarea's value around each keydown
// (`newValue.replace(oldValue, '')`), which assumes edits only ever append. A
// suggestion tap that rewrites a word mid-value breaks that assumption: the
// diff no longer matches and xterm re-sends the WHOLE value, and a suggestion
// commit also fires two 229 keydowns that each send the same diff
// (xtermjs/xterm.js#3600). We can't just empty the textarea to dodge this —
// Gboard reads it for context, and with it empty it stops offering suggestions.
//
// Instead we leave the textarea alone and reconcile it ourselves: the value at
// `beforeinput` vs. at `input` is exactly one edit, so its common prefix/suffix
// give the removed and inserted text, sent once as DEL×n + text. Events we own
// are stopped in the capture phase on xterm's root element, which always runs
// before xterm's own listeners on the textarea (a listener on the textarea
// itself would fire after them, in registration order). Anything composing is
// left to xterm.
const DEL = "\x7f";
const CR = "\r";
// Composition edits stay with xterm; everything else that reaches `input`
// after a swallowed 229 keydown (text, replacements, deletes, line breaks,
// paste) is reconciled here, since swallowing the keydown removes xterm's own
// textarea-diff fallback for it.
const COMPOSITION_INPUT_TYPES = new Set([
  "insertCompositionText",
  "insertFromComposition",
  "deleteCompositionText",
]);
const LINE_BREAK_INPUT_TYPES = new Set(["insertLineBreak", "insertParagraph"]);

export function diffEdit(before: string, after: string): { removed: number; inserted: string } {
  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  return {
    removed: before.length - prefix - suffix,
    inserted: after.slice(prefix, after.length - suffix),
  };
}

export function attachImeInput(term: Pick<Terminal, "input" | "textarea" | "element">): () => void {
  const { textarea, element: root } = term;
  if (!textarea || !root) return () => {};

  let composing = false;
  // Non-null between an owned `beforeinput` and its `input`.
  let before: { value: string; inputType: string } | null = null;

  const onCompositionStart = (): void => {
    composing = true;
  };
  const onCompositionEnd = (): void => {
    composing = false;
  };
  const fromTextarea = (ev: Event): boolean => ev.target === textarea;
  const onKeyDown = (ev: KeyboardEvent): void => {
    if (fromTextarea(ev) && ev.keyCode === 229 && !composing) ev.stopPropagation();
  };
  const onBeforeInput = (ev: InputEvent): void => {
    if (!fromTextarea(ev)) return;
    before =
      !composing && !ev.isComposing && !COMPOSITION_INPUT_TYPES.has(ev.inputType)
        ? { value: textarea.value, inputType: ev.inputType }
        : null;
  };
  const onInput = (ev: Event): void => {
    if (!fromTextarea(ev) || before === null) return;
    const { value: prev, inputType } = before;
    before = null;
    ev.stopPropagation();
    if (LINE_BREAK_INPUT_TYPES.has(inputType)) {
      // The terminal wants CR, not the textarea's "\n".
      term.input(CR, true);
      return;
    }
    const { removed, inserted } = diffEdit(prev, textarea.value);
    const out = DEL.repeat(removed) + inserted;
    if (out) term.input(out, true);
  };

  const opts = { capture: true } as const;
  root.addEventListener("compositionstart", onCompositionStart, opts);
  root.addEventListener("compositionend", onCompositionEnd, opts);
  root.addEventListener("keydown", onKeyDown, opts);
  root.addEventListener("beforeinput", onBeforeInput as EventListener, opts);
  root.addEventListener("input", onInput, opts);

  return () => {
    root.removeEventListener("compositionstart", onCompositionStart, opts);
    root.removeEventListener("compositionend", onCompositionEnd, opts);
    root.removeEventListener("keydown", onKeyDown, opts);
    root.removeEventListener("beforeinput", onBeforeInput as EventListener, opts);
    root.removeEventListener("input", onInput, opts);
  };
}
