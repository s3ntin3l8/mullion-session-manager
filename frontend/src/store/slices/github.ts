import type { StateCreator } from "zustand";
// GitHubWSEvent physically lives in src/shared/ws-protocol.ts (repo root,
// NOT this frontend workspace — see src/services/github-ws-broadcast.ts's
// own re-export), the backend's /ws/github push-event shape. Used below to
// narrow connectGitHubWS's incoming message instead of hand-inspecting an
// `unknown`-typed parse.
import type { GitHubWSEvent } from "../../../../src/shared/ws-protocol.js";
import type { DashboardState, GithubSlice } from "../types.js";

export const createGithubSlice: StateCreator<DashboardState, [], [], GithubSlice> = (set, get) => {
  let gitHubWS: WebSocket | null = null;
  const gitHubWSSubscriptions: Set<number> = new Set();
  // Hermes review, PR #577/#580 — connectGitHubWS's onmessage below calls
  // refreshGitRefs() on every /ws/github event with a projectId (push, PR
  // sync, CI started/completed); a single check suite can fire several in
  // quick succession. Debounced so a burst collapses into one refetch.
  let gitRefsEventRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const GIT_REFS_EVENT_REFRESH_DEBOUNCE_MS = 250;

  return {
    prsRefreshTrigger: 0,
    githubWSConnected: false,

    connectGitHubWS: () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws/github`;
      const ws = new WebSocket(wsUrl);
      gitHubWS = ws;
      set({ githubWSConnected: false });

      ws.onopen = () => {
        set({ githubWSConnected: true });
        for (const projectId of gitHubWSSubscriptions) {
          ws.send(JSON.stringify({ type: "subscribe", projectId }));
        }
      };

      ws.onclose = () => {
        set({ githubWSConnected: false });
        if (gitHubWS === ws) gitHubWS = null;
      };

      ws.onerror = () => {
        if (gitHubWS === ws) gitHubWS = null;
      };

      ws.onmessage = (event) => {
        try {
          // An unchecked type assertion, not a runtime-validated narrowing
          // — JSON.parse still returns `unknown` underneath; this just
          // documents the shape this handler expects from the backend
          // (every arm of GitHubWSEvent carries `projectId: string`). The
          // `!= null` guard below is kept precisely because the assertion
          // proves nothing at runtime: a malformed/unexpected frame from a
          // version-skewed backend still parses fine, just without a real
          // `projectId`, and that guard is what actually protects against
          // it.
          const data = JSON.parse(event.data as string) as GitHubWSEvent;
          if (data.projectId != null) {
            set((state) => ({ prsRefreshTrigger: state.prsRefreshTrigger + 1 }));
            // prsRefreshTrigger alone only reaches GitHubPanel (its own
            // effect dependency) — prsByProject itself, which every OTHER
            // consumer (Sidebar's SessionRow, UnifiedBoard's TaskCard,
            // TaskDetail) reads directly, stays on refreshGitRefs' own
            // ~60s throttle otherwise. Refreshing it here too means a real
            // GitHub push (a check completing, a new PR) reaches every
            // consumer within one WS round trip, not up to a minute later.
            // Debounced (not called directly) — refreshGitRefs itself has
            // no time throttle of its own, only in-flight dedup, so a check
            // suite's burst of started/completed events would otherwise
            // fire one refetch per event.
            if (gitRefsEventRefreshTimer) clearTimeout(gitRefsEventRefreshTimer);
            gitRefsEventRefreshTimer = setTimeout(() => {
              gitRefsEventRefreshTimer = null;
              void get().refreshGitRefs();
            }, GIT_REFS_EVENT_REFRESH_DEBOUNCE_MS);
          }
        } catch (err) {
          console.warn("[GitHubWS] failed to parse message:", err);
        }
      };

      return () => {
        ws.close();
        if (gitRefsEventRefreshTimer) {
          clearTimeout(gitRefsEventRefreshTimer);
          gitRefsEventRefreshTimer = null;
        }
        if (gitHubWS === ws) {
          gitHubWS = null;
          set({ githubWSConnected: false });
        }
      };
    },

    subscribeToGitHubProject: (projectId: number) => {
      gitHubWSSubscriptions.add(projectId);
      if (gitHubWS?.readyState === WebSocket.OPEN) {
        gitHubWS.send(JSON.stringify({ type: "subscribe", projectId }));
      }
    },

    unsubscribeFromGitHubProject: (projectId: number) => {
      gitHubWSSubscriptions.delete(projectId);
      // P12 — this used to be local-cleanup-only: the server kept pushing
      // events for a project whose UI section had already unmounted,
      // because nothing ever told it to stop. Mirrors subscribeToGitHubProject
      // above (same guard, same frame shape, same send mechanism).
      //
      // NOTE for reviewers: as of this PR, `src/routes/ws-github.ts` only
      // recognizes `{type: "subscribe", projectId}` — there is no server-side
      // handler for `"unsubscribe"` at all, and
      // `src/services/github-ws-broadcast.ts`'s `subscribeToProject` only
      // ever removes a socket from a project's subscriber set on the
      // socket's own `close`/`error` (i.e. the whole shared `/ws/github`
      // connection closing), not on a per-project unsubscribe. So this frame
      // is inert until the backend grows a handler for it — a separate,
      // backend-side, out-of-scope change for this frontend-only PR (see the
      // plan's P12 finding). Sending it now means the fix is a pure backend
      // addition later, with nothing left to do frontend-side.
      if (gitHubWS?.readyState === WebSocket.OPEN) {
        gitHubWS.send(JSON.stringify({ type: "unsubscribe", projectId }));
      }
    },
  };
};
