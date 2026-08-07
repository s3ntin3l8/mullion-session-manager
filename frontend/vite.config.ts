import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// In prod this frontend is built and served same-origin by the Fastify
// backend (see src/plugins/static.ts) — no proxy needed there. In dev, Vite
// runs on its own port with HMR, so /api and /ws are proxied through to the
// backend dev server instead. Override the target with BACKEND_URL if the
// backend isn't on its default .env port (3450).
const backendUrl = process.env.BACKEND_URL || "http://localhost:3450";

export default defineConfig(({ command, mode }) => {
  // A dev shell exporting NODE_ENV=production (see #82/#114) otherwise leaks
  // into the dev server: Vite derives isProduction from NODE_ENV, so `vite
  // dev` would set skipFastRefresh and drop @vitejs/plugin-react's
  // Fast-Refresh preamble while its oxc transform still emits $RefreshReg$
  // registrations in every module — ReferenceError + blank screen (#105).
  // Correct NODE_ENV to match `mode` (which defaults to "development" for
  // `serve`, but still honors an explicit `--mode` override) whenever the
  // leak has left it wrongly pinned to "production". Skip when `mode` is
  // itself "production" — someone intentionally running the dev server in
  // production mode gets to keep it.
  if (command === "serve" && process.env.NODE_ENV === "production" && mode !== "production") {
    console.warn(
      `[vite.config] Correcting leaked NODE_ENV=production to "${mode}" for the dev server (see #105).`,
    );
    process.env.NODE_ENV = mode;
  }
  return {
    plugins: [
      react(),
      // Issue #87 (part 2 — the service worker half, split from #542's
      // manifest/iOS work for independent revertability: this repo
      // squash-merges, so a bad service worker needs to be one revert, not
      // half of one). manifest: false — site.webmanifest is hand-authored
      // (public/, #542) with careful id/start_url/scope/maskable-icon work;
      // letting this plugin generate its own competing manifest.webmanifest
      // and <link rel="manifest"> would fight it. injectRegister stays at
      // its "auto" default, which auto-injects a registration script since
      // no app code imports virtual:pwa-register itself.
      VitePWA({
        registerType: "autoUpdate",
        manifest: false,
        includeManifestIcons: false,
        devOptions: { enabled: false },
        workbox: {
          // No client-side router in this app (no router dependency, no
          // history.pushState/hash usage anywhere in frontend/src) and
          // src/plugins/static.ts registers @fastify/static with a bare
          // { root } — no SPA index.html rewrite. The only real URL is "/".
          // navigateFallback: "index.html" would make the SW answer
          // navigations to paths the server itself 404s, inventing routes
          // that don't exist. navigateFallbackDenylist is kept anyway as
          // documentation of intent even though it's inert with
          // navigateFallback null.
          navigateFallback: null,
          navigateFallbackDenylist: [/^\/api\//, /^\/ws\//, /^\/health/, /^\/ready/],
          // No runtimeCaching at all — Workbox only intercepts requests it's
          // explicitly told to, so /api/* and /ws/* stay NetworkOnly by
          // default. This also settles the auth question: src/plugins/
          // auth.ts's own doc comment establishes the SPA shell must load
          // unauthenticated before it can even call GET /api/auth/me, so
          // the precached shell contains no authed content to begin with —
          // nothing here can go stale or leak.
          runtimeCaching: [],
          // Issue #95 — imports public/push-sw.js's push/notificationclick/
          // pushsubscriptionchange handlers into the generated service
          // worker (Workbox's own generateSW option, emitted as a literal
          // importScripts([...]) call at the top of the output). Chosen over
          // switching this plugin to the injectManifest strategy (which
          // would mean hand-writing precacheAndRoute/skipWaiting/
          // clientsClaim/cleanupOutdatedCaches ourselves) specifically
          // because that would replace the #546 auto-update config whose
          // real-device correctness is itself unverified (see #552) —
          // additive is safer than rewriting the artifact under test.
          importScripts: ["push-sw.js"],
          // Without this, the default globPatterns would precache
          // push-sw.js's own bytes into the manifest it's imported into —
          // harmless (SW script fetches bypass the SW's own fetch handler)
          // but confusing noise in the generated manifest.
          globIgnores: ["**/push-sw.js"],
          // cleanupOutdatedCaches (+ skipWaiting/clientsClaim, which
          // registerType: "autoUpdate" sets automatically, and main.tsx's
          // explicit registerSW() call, which is what actually reloads an
          // already-open tab once the new SW activates — autoUpdate alone
          // only makes the SW itself take over, it doesn't reload already-
          // loaded JS) is the mitigation for the main hazard here:
          // scripts/self-update.sh's versioned-release layout means a new
          // backend process serves ONLY its own release dir's assets, so a
          // stale tab's next reload must actually get fresh content, not
          // silently keep running old JS against a new backend indefinitely.
          // One narrower edge case this doesn't fully close: if the browser
          // partially evicts Cache Storage (iOS Safari's 7-day non-
          // interaction sweep, low-storage pressure) between deploys,
          // precacheAndRoute falls back to a network fetch for the missing
          // entry — a hard 404 for that specific old-hash asset (the old
          // release dir is gone), not stale content. Self-heals on the SW's
          // own next background update cycle; narrower than the
          // forever-stale-app failure mode this config is built to avoid.
          cleanupOutdatedCaches: true,
        },
      }),
    ],
    server: {
      host: true,
      proxy: {
        "/api": backendUrl,
        "/ws": { target: backendUrl, ws: true },
      },
    },
  };
});
