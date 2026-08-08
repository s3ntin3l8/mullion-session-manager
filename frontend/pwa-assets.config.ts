import { defineConfig, createAppleSplashScreens } from "@vite-pwa/assets-generator/config";

// Issue #87 — generates only the Apple splash screens (`apple-splash-*.png`
// in public/). Icon generation is disabled: public/'s icon-192, icon-512,
// icon-512-maskable, apple-touch-icon and safari-pinned-tab.svg are hand-made
// (#542) and must not be regenerated or shadowed by this tool's naming
// scheme. `logo.svg` (byte-identical to favicon.svg — the app's four-tile
// glyph) is used as the source; Apple splash screens are conventionally the
// app icon centered on a solid background, not separate artwork.
export default defineConfig({
  headLinkOptions: { preset: "2023" },
  images: ["public/logo.svg"],
  preset: {
    transparent: { sizes: [] },
    maskable: { sizes: [] },
    apple: { sizes: [] },
    appleSplashScreens: createAppleSplashScreens({
      padding: 0.3,
      // Matches site.webmanifest's background_color so the splash is
      // continuous with the app shell's own background.
      resizeOptions: { background: "#0e1512", fit: "contain" },
      linkMediaOptions: { log: true },
      // Only a single (non-dark) variant is generated here, so `dark` is
      // always `undefined` — but the library's own default naming
      // function treats that differently depending on call site: the
      // file-writer omits the light/dark infix while the html-head-link
      // generator injects "-light-" regardless, producing hrefs that
      // 404 against the actual filenames. Pinning an explicit name
      // function that ignores `dark` keeps both call sites consistent.
      name: (landscape, size) =>
        `apple-splash-${landscape ? "landscape" : "portrait"}-${size.width}x${size.height}.png`,
    }),
  },
});
