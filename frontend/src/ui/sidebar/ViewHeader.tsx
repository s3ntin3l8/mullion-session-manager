import { useContext, type ReactNode } from "react";
import { ExternalLinkOwnedContext } from "./externalLinkOwned.js";
import { GitHubIcon } from "../icons.js";
import { IconButton } from "./IconButton.js";

export interface ViewHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Contextual icon actions, left of the open-on-GitHub link. */
  actions?: ReactNode;
  /** Whatever is selected on GitHub; renders the standard top-right icon. */
  externalUrl?: string | null;
  externalLabel?: string;
  /** Rendered before the title (DetailHeader's back button). */
  leading?: ReactNode;
  /** Pin the header to the top of the scrolling view it sits in. */
  sticky?: boolean;
  /** Inside the drawer's header row: no bar of its own, and the open-on-GitHub
   * link shows even where a toolbar would own it (the toolbar is hidden). */
  bare?: boolean;
}

export function ViewHeader({
  title,
  subtitle,
  actions,
  externalUrl,
  externalLabel = "Open on GitHub",
  leading,
  sticky,
  bare,
}: ViewHeaderProps) {
  const linkOwned = useContext(ExternalLinkOwnedContext);
  return (
    // `bare` wins over `sticky`: in the drawer's header row the header is
    // already fixed, so there is nothing to stick (IssuesView passes both).
    <div className={bare ? "sb-vh sb-vh--bare" : sticky ? "sb-vh sb-vh--sticky" : "sb-vh"}>
      {leading}
      <div className="sb-vh-title">
        <span className="sb-vh-name">{title}</span>
        {subtitle != null && <span className="sb-vh-sub">{subtitle}</span>}
      </div>
      <div className="sb-vh-actions">
        {actions}
        {externalUrl && (bare || !linkOwned) && (
          <>
            {actions != null && <span className="sb-vh-sep" aria-hidden="true" />}
            <IconButton external label={externalLabel} href={externalUrl}>
              <GitHubIcon size={14} />
            </IconButton>
          </>
        )}
      </div>
    </div>
  );
}
