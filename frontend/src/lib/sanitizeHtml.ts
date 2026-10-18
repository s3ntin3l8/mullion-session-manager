import DOMPurify from "dompurify";

// GitHub-rendered issue/comment HTML (`body_html`). GitHub sanitizes it
// server-side, but it is still third-party-authored markup, so it goes
// through DOMPurify before reaching the DOM, and links are forced to open
// out of the app without a referrer.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export function sanitizeGithubHtml(html: string): string {
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}
