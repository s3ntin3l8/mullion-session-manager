import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthGate } from "./AuthGate.js";
// B1 — self-hosted via @fontsource instead of a fonts.googleapis.com/
// fonts.gstatic.com <link> in index.html: this is a self-hosted, typically
// LAN/VPN-only dashboard, so a third-party font CDN is a render-blocking
// dependency on every load, a hard failure mode on an air-gapped host (the
// Workbox precache in vite.config.ts never covered the CDN origin), and a
// per-load ping to Google. Each import below pulls in exactly the weights
// the removed Google Fonts URL requested
// (`family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&
// family=JetBrains+Mono:wght@400;500&family=IBM+Plex+Mono:wght@400;500`) —
// importing the package's index.css instead would silently pull in every
// weight (100-900) and bloat the precache. The .woff2 files land
// content-hashed under dist/assets/ via Vite's normal asset pipeline, so
// they're covered by the Workbox precache manifest like any other build
// asset (see vite.config.ts's VitePWA globPatterns) — that's this fix's
// actual success criterion, not just "same-origin".
import "@fontsource/geist/400.css";
import "@fontsource/geist/500.css";
import "@fontsource/geist/600.css";
import "@fontsource/geist/700.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
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
