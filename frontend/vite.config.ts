import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In prod this frontend is built and served same-origin by the Fastify
// backend (see src/plugins/static.ts) — no proxy needed there. In dev, Vite
// runs on its own port with HMR, so /api and /ws are proxied through to the
// backend dev server instead. Override the target with BACKEND_URL if the
// backend isn't on its default .env port (3450).
const backendUrl = process.env.BACKEND_URL || "http://localhost:3450";

export default defineConfig(({ command }) => {
  // A dev shell exporting NODE_ENV=production (see #82/#114) otherwise leaks
  // into the dev server: Vite derives isProduction from NODE_ENV, so `vite
  // dev` would set skipFastRefresh and drop @vitejs/plugin-react's
  // Fast-Refresh preamble while its oxc transform still emits $RefreshReg$
  // registrations in every module — ReferenceError + blank screen (#105). A
  // dev server is always development; correct the leak so the preamble is
  // injected.
  if (command === "serve" && process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "development";
  }
  return {
    plugins: [react()],
    server: {
      proxy: {
        "/api": backendUrl,
        "/ws": { target: backendUrl, ws: true },
      },
    },
  };
});
