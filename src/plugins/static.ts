import fp from "fastify-plugin";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";

// The frontend (frontend/ — its own Vite project, see M3) is built
// separately and not guaranteed to exist: local dev commonly runs the
// backend and Vite's own dev server side by side instead (Vite proxies
// /api and /ws to this backend), and CI's `npm ci` never touches
// frontend/'s package.json at all. Registering @fastify/static against a
// missing root throws at startup, so this is a no-op until the directory
// is actually there — rootRoute's placeholder handles "/" until then.
// Perf audit finding A4 — Vite content-hashes every file under `assets/`
// (its default `assetsDir`), so a given URL's bytes never change; it's safe
// (and, per the audit, the single biggest day-to-day UX cost left unfixed)
// to cache those forever. `index.html` and the generated service worker
// (`sw.js`) are the opposite: `frontend/vite.config.ts`'s VitePWA config
// runs `registerType: "autoUpdate"`, which depends on the browser
// re-fetching and diffing `sw.js`'s bytes on every load to detect an
// update, and `index.html` is what points at the current release's
// content-hashed asset URLs in the first place — both must keep the
// existing effectively-uncached (`maxAge: 0`) behavior below, not the
// long-cache override.
//
// setHeaders below scopes this to the served path (relative to `root`),
// not a substring check against the full filesystem path — FRONTEND_DIST
// itself could sit under a directory that happens to contain an "assets"
// path segment (e.g. `/srv/assets/mullion-dist`), which a bare
// `filePath.includes("/assets/")` would have wrongly matched for
// index.html/sw.js too, silently breaking the VitePWA autoUpdate flow this
// comment describes.
const ASSETS_DIR_PREFIX = `assets${path.sep}`;

export const staticPlugin = fp(async (app: FastifyInstance) => {
  const root = path.resolve(app.config.FRONTEND_DIST);
  if (!existsSync(root)) {
    app.log.debug(`frontend build not found at ${root}; skipping static asset serving`);
    return;
  }

  await app.register(fastifyStatic, {
    root,
    // Default for everything NOT overridden below (index.html, sw.js,
    // manifest, etc.) — matches this route's pre-existing behavior
    // (`cache-control: public, max-age=0`), so those keep being revalidated
    // on every request.
    maxAge: 0,
    setHeaders: (reply, filePath) => {
      const relative = path.relative(root, filePath);
      if (relative === "assets" || relative.startsWith(ASSETS_DIR_PREFIX)) {
        reply.header("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  });
});
