import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthGate } from "./AuthGate.js";
import "./styles.css";

// Issue #87 — registerType: "autoUpdate" (vite.config.ts) only makes the
// SERVICE WORKER itself take over immediately (skipWaiting/clientsClaim);
// it does nothing to an already-open tab's already-loaded JS on its own.
// Without this explicit registerSW() call, vite-plugin-pwa falls back to
// injecting a bare navigator.serviceWorker.register() with no
// update-reload wiring at all — reviewed and confirmed against the
// plugin's own client source (workbox-window's Workbox class fires
// "activated" with isUpdate/isExternal, which registerSW()'s default
// behavior turns into window.location.reload() when no onNeedReload is
// given). That reload is the actual fix for this PR's stated hazard: a
// tab left open across a scripts/self-update.sh backend swap would
// otherwise keep running stale JS against a new backend indefinitely.
// Safe here specifically because this app's reconnect path (WS backoff,
// PTY reattach/redraw) is already a first-class, tested scenario — a
// reload just triggers the same reconnect a network blip would.
if (import.meta.env.PROD) {
  void import("virtual:pwa-register").then(({ registerSW }) => registerSW());
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthGate />
  </StrictMode>,
);
