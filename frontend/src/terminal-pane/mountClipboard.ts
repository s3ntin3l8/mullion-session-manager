// Closure body moved out of TerminalPane's mount effect (issue #2406).
// The effect calls this factory at the declaration site and binds the
// returned functions to the same local names. Construction, the WebGL
// atlas sequence, OSC 10/11/12 registration, and the cleanup list stayed
// in the effect. Shared mutable locals are the explicit MountBag, not refs.

import type { Dispatch, SetStateAction } from "react";
import type { Terminal } from "@xterm/xterm";
import { hasClipboardApi } from "../lib/terminalKeys.js";
import type { MountBag } from "./mountBag.js";

export interface MountClipboardDeps {
  term: Terminal;
  withoutCtrl: (send: () => void) => void;
  setCopyFailedMessage: Dispatch<SetStateAction<string | null>>;
  setCopyFailedToastKey: Dispatch<SetStateAction<number>>;
  setCopied: Dispatch<SetStateAction<boolean>>;
  setCopyToastKey: Dispatch<SetStateAction<number>>;
}

export function attachMountClipboard(bag: MountBag, deps: MountClipboardDeps) {
  const {
    term,
    withoutCtrl,
    setCopyFailedMessage,
    setCopyFailedToastKey,
    setCopied,
    setCopyToastKey,
  } = deps;

  // The failure half of copyToClipboard below — previously a console.warn
  // only, which made a clobbered/rejected copy invisible from the UI (see
  // copyFailedMessage's own comment). Same transient-toast shape as the
  // success path (1.5s, remount key so back-to-back failures each restart
  // the fade), kept as its own function since it has two call sites. Takes
  // the message itself (Hermes review) rather than a fixed string, so a
  // non-secure-context deploy ("Clipboard unavailable") and an actually
  // rejected write ("Copy failed") read as the two distinct situations
  // they are, instead of one undifferentiated failure toast.
  function showCopyFailed(message: string): void {
    if (bag.destroyed) return;
    setCopyFailedMessage(message);
    setCopyFailedToastKey((k) => k + 1);
    if (bag.copyFailedToastTimer) clearTimeout(bag.copyFailedToastTimer);
    bag.copyFailedToastTimer = setTimeout(() => {
      if (bag.destroyed) return;
      setCopyFailedMessage(null);
    }, 1500);
  }

  // Shared by "copy on select", the OSC 52 handler, and the Ctrl+Insert/
  // Ctrl+C handlers below. Returns whether the write actually landed — the
  // opt-in Ctrl+C path (attachKeyConflictHandler) needs that to decide
  // whether it's safe to clear the selection; the other callers ignore it.
  //
  // `notifyOnFailure` (Hermes review) defaults to true for the three
  // explicit-copy callers (OSC 52 live output, Ctrl+Insert, the opt-in
  // Ctrl+C chord) — each is a deliberate "copy this" action, so a failure
  // is worth surfacing. "Copy on select" below passes false: it fires on
  // every selection change, including an accidental drag, so in a
  // non-secure-context deploy it would otherwise flash a failure toast on
  // every incidental selection rather than a real, intentional copy.
  function copyToClipboard(text: string, notifyOnFailure = true): Promise<boolean> {
    if (!hasClipboardApi()) {
      console.warn("[terminal] clipboard API not available (not a secure context)");
      if (notifyOnFailure) showCopyFailed("Clipboard unavailable");
      return Promise.resolve(false);
    }
    return navigator.clipboard
      .writeText(text)
      .then(() => {
        if (bag.destroyed) return true;
        setCopied(true);
        setCopyToastKey((k) => k + 1);
        if (bag.copyToastTimer) clearTimeout(bag.copyToastTimer);
        bag.copyToastTimer = setTimeout(() => {
          if (bag.destroyed) return;
          setCopied(false);
        }, 1500);
        return true;
      })
      .catch((err: unknown) => {
        console.warn("[terminal] clipboard write failed:", err);
        if (notifyOnFailure) showCopyFailed("Copy failed");
        return false;
      });
  }

  // Strips a trailing newline from clipboard text before it reaches the
  // PTY. Clipboard content copied from a terminal commonly ends in `\n`;
  // sent as-is, that lands on the shell as Enter and the pasted command
  // executes immediately instead of sitting at the prompt for review
  // (see issue #66). Routing through term.paste() below (rather than a
  // raw ws.send) additionally wraps the text in bracketed-paste escapes
  // (`\x1b[200~`/`\x1b[201~`) whenever the foreground app has enabled
  // bracketed paste mode (DECSET 2004 — bash/zsh/most TUIs) — the backend
  // PTY is a raw passthrough (routes/terminal.ts, pty-manager.ts) with no
  // filtering, so it needs no special support for this; xterm generates
  // and the shell interprets the escapes entirely client/foreground-app
  // side.
  function pasteToTerminal(text: string): void {
    const trimmed = text.replace(/[\r\n]+$/, "");
    if (trimmed) withoutCtrl(() => term.paste(trimmed));
  }

  return { showCopyFailed, copyToClipboard, pasteToTerminal };
}
