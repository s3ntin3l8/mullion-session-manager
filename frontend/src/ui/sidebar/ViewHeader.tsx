import type { ReactNode } from "react";
import { ExternalLinkIcon } from "../icons.js";
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
}

export function ViewHeader({
  title,
  subtitle,
  actions,
  externalUrl,
  externalLabel = "Open on GitHub",
  leading,
}: ViewHeaderProps) {
  return (
    <div className="sb-vh">
      {leading}
      <div className="sb-vh-title">
        <span className="sb-vh-name">{title}</span>
        {subtitle != null && <span className="sb-vh-sub">{subtitle}</span>}
      </div>
      <div className="sb-vh-actions">
        {actions}
        {externalUrl && (
          <>
            {actions != null && <span className="sb-vh-sep" aria-hidden="true" />}
            <IconButton external label={externalLabel} href={externalUrl}>
              <ExternalLinkIcon size={14} />
            </IconButton>
          </>
        )}
      </div>
    </div>
  );
}
