// Link hover/leave/activate closures moved out of TerminalPane's mount effect
// (issue #2406). The effect calls this before `new Terminal` and binds the
// four functions to the same names the linkHandler option and the link
// providers close over. These closures do not touch the mount bag — they
// don't share `ws` / `destroyed` / the reconnect locals. Construction, the
// WebGL atlas sequence, OSC 10/11/12 registration, and the cleanup list
// stayed in the effect.

import type { Dispatch, SetStateAction } from "react";
import { isSafeLinkUrl } from "../lib/terminalLinks.js";

export interface MountLinksDeps {
  container: HTMLElement;
  isCoarsePointer: boolean;
  setLinkTooltip: Dispatch<
    SetStateAction<{ text: string; rowCount: number; x: number; y: number } | null>
  >;
}

export function attachMountLinks(deps: MountLinksDeps) {
  const { container, isCoarsePointer, setLinkTooltip } = deps;

  // Shared by both link surfaces in TerminalPane.tsx — the wrap-aware `ILinkProvider`
  // (regex-matched http(s) URLs, including ones lib/terminalLinks.ts
  // reconstructs across hard-wrapped rows) and the `linkHandler` option
  // (OSC 8 hyperlinks, which xterm core handles entirely on its own). One
  // pair of hover/leave closures and one tooltip for both — but NOT one
  // shared `activate`. See `activateOscLink` below for why OSC 8 keeps its
  // own gate: unlike our own provider, where the visible text and the
  // navigated-to URL are the same string by construction (the match comes
  // straight from what's printed in the buffer), an OSC 8 hyperlink lets
  // the emitting process set the DISPLAYED text completely independently
  // of the real href (`ESC]8;;https://evil.example\ESC\Read the docs
  // ESC]8;;\ESC\`) — a known terminal phishing vector, which is exactly
  // why xterm's own default OSC 8 handler (which setting any
  // `linkHandler` at all replaces) gates activation behind
  // `confirm("Do you want to navigate to …? WARNING: this link could
  // potentially be dangerous")`. Losing that confirmation here, silently,
  // was a real regression caught in review — restored below, scoped to
  // just the OSC 8 path; our own provider's links don't need it, since
  // there is nothing to spoof.
  const hoverLink = (event: MouseEvent, text: string, rowCount: number) => {
    // No hover on touch — nothing to preview against, and the tooltip
    // would just get stuck showing after a tap. Clicking still opens.
    if (isCoarsePointer) return;
    // Relative to the outer `position: relative` wrapper the tooltip is
    // positioned in — not `container`, which is inset by the padding.
    const rect = (container.parentElement ?? container).getBoundingClientRect();
    setLinkTooltip({
      text,
      rowCount,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  };
  const leaveLink = () => setLinkTooltip(null);
  // For our own provider (lib/terminalLinks.ts): the hover tooltip is
  // already the disclosure — what it shows IS what a click opens, so no
  // extra confirmation step.
  const activateLink = (_event: MouseEvent, text: string) => {
    if (!isSafeLinkUrl(text)) return;
    window.open(text, "_blank", "noopener,noreferrer");
  };
  const activateOscLink = (_event: MouseEvent, text: string) => {
    if (!isSafeLinkUrl(text)) return;
    if (!window.confirm(`Open this link?\n\n${text}`)) return;
    window.open(text, "_blank", "noopener,noreferrer");
  };

  return { hoverLink, leaveLink, activateLink, activateOscLink };
}
