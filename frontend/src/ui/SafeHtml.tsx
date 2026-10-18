import { useMemo } from "react";
import { sanitizeGithubHtml } from "../lib/sanitizeHtml.js";

/** Renders GitHub-rendered HTML after sanitizing it (see lib/sanitizeHtml.ts). */
export function SafeHtml({ html, className }: { html: string; className?: string }) {
  const clean = useMemo(() => sanitizeGithubHtml(html), [html]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: clean }} />;
}
