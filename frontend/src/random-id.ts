// crypto.randomUUID() is only exposed in secure contexts (https, or
// localhost) — not a plain-http LAN/Tailscale deployment, which
// docs/browser-previews.md documents as a supported way to use the
// direct-embed browser pane (issue #28): calling it there throws
// ("crypto.randomUUID is not a function"). Anything that only needs an
// opaque, merely-locally-unique id (a dockview panel id, not a real UUID)
// falls back to a plain random string instead of hard-requiring Web
// Crypto — still prefers crypto.randomUUID() when it's available.
export function randomPanelId(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
}
