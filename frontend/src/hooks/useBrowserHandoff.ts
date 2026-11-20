import { useEffect, useState } from "react";
import { browserApi } from "../api/browser.js";
import type { PreviewForAgentAddress } from "../api/browser.js";
import {
  HANDOFF_AGENT_PAGE_NOT_HTTP,
  HANDOFF_FAILED,
  HANDOFF_NO_AGENT_PAGE,
  HANDOFF_NO_PREVIEW_ADDRESS,
  HANDOFF_PENDING,
  addressHandoffRefusal,
  isHttpAddress,
  previewSourceKey,
} from "../lib/browserHandoff.js";
import type { PreviewSource } from "../lib/browserHandoff.js";

// What the Browser pane's ⇄ button would open (#3373, docs/design/
// one-browser-pane/note.md, "Open this address in the other one"), and why
// it cannot when it cannot. BrowserShell owns the switching; the button is
// BrowserHandoff.tsx.

/** What ⇄ would do: an address to open, or why it cannot. */
export type Handoff<T> = { ok: true; value: T } | { ok: false; reason: string };

type Answer<T> = { key: string; handoff: Handoff<T> };

/**
 * Preview -> agent's browser. An address the client knows (typed, saved,
 * followed) goes as is, unless it is not http(s) or names localhost; a project
 * preview asks the server, which answers from the session's browser target.
 */
export function useAgentAddressForPreview(
  sessionId: number | null,
  source: PreviewSource | null,
): Handoff<string> {
  const remote = sessionId != null && source?.kind === "project";
  const key = remote ? `${sessionId}|${previewSourceKey(source)}` : "";
  const slug = source?.kind === "project" ? source.slug : undefined;
  const [answer, setAnswer] = useState<Answer<string> | null>(null);
  useEffect(() => {
    if (!remote || sessionId == null) return;
    let cancelled = false;
    browserApi
      .getAgentAddressForPreview(sessionId, slug)
      .then((res) => {
        if (cancelled) return;
        setAnswer({
          key,
          handoff: res.ok ? { ok: true, value: res.url } : { ok: false, reason: res.reason },
        });
      })
      .catch(() => {
        if (!cancelled) setAnswer({ key, handoff: { ok: false, reason: HANDOFF_FAILED } });
      });
    return () => {
      cancelled = true;
    };
  }, [remote, sessionId, slug, key]);

  if (source == null) return { ok: false, reason: HANDOFF_NO_PREVIEW_ADDRESS };
  if (source.kind === "address") {
    const refusal = addressHandoffRefusal(source.url);
    return refusal ? { ok: false, reason: refusal } : { ok: true, value: source.url };
  }
  // Fails closed: until the server answers for this very source, ⇄ waits.
  if (answer?.key !== key) return { ok: false, reason: HANDOFF_PENDING };
  return answer.handoff;
}

/**
 * Agent's browser -> preview. The server knows the project's dev servers and
 * preview targets, and which host the session's browser runs on, so it says
 * which preview shows the page; a page that is not http(s) never asks.
 */
export function usePreviewForAgentAddress(
  sessionId: number | null,
  url: string | null,
): Handoff<Exclude<PreviewForAgentAddress, { kind: "disabled" }>> {
  const usable = sessionId != null && url != null && isHttpAddress(url);
  const key = usable ? `${sessionId}|${url}` : "";
  const [answer, setAnswer] = useState<Answer<
    Exclude<PreviewForAgentAddress, { kind: "disabled" }>
  > | null>(null);
  useEffect(() => {
    if (!usable || sessionId == null || url == null) return;
    let cancelled = false;
    browserApi
      .getPreviewForAgentAddress(sessionId, url)
      .then((res) => {
        if (cancelled) return;
        setAnswer({
          key,
          handoff:
            res.kind === "disabled" ? { ok: false, reason: res.reason } : { ok: true, value: res },
        });
      })
      .catch(() => {
        if (!cancelled) setAnswer({ key, handoff: { ok: false, reason: HANDOFF_FAILED } });
      });
    return () => {
      cancelled = true;
    };
  }, [usable, sessionId, url, key]);

  if (!usable) {
    // A page that is not http(s) (about:blank, chrome://…) is not "no page".
    const shown = url != null && url.trim() !== "" && url !== "about:blank";
    return { ok: false, reason: shown ? HANDOFF_AGENT_PAGE_NOT_HTTP : HANDOFF_NO_AGENT_PAGE };
  }
  if (answer?.key !== key) return { ok: false, reason: HANDOFF_PENDING };
  return answer.handoff;
}
