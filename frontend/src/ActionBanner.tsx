import type { ReactNode } from "react";

// The one-line banners above the workspace (update available, Codex hooks not
// trusted, low disk space): click anywhere to open the related settings, ×
// to dismiss. The banner itself is not a control: a role="button" holding the
// dismiss control fails axe's nested-interactive (#2886). Its one keyboard
// control is a real <button> around the icon and text, the dismiss button sits
// beside it, and the banner's own click handler keeps the rest of the strip a
// pointer target.
export function ActionBanner({
  className,
  icon,
  title,
  subtext,
  onOpen,
  onDismiss,
  dismissTitle,
}: {
  className?: string;
  icon: ReactNode;
  title: ReactNode;
  subtext: ReactNode;
  onOpen: () => void;
  onDismiss?: () => void;
  dismissTitle?: string;
}) {
  return (
    <div className={`update-banner${className ? ` ${className}` : ""}`} onClick={onOpen}>
      <button
        type="button"
        className="update-banner-open"
        onClick={(e) => {
          // The banner's handler opens it; one click, one open.
          e.stopPropagation();
          onOpen();
        }}
      >
        {icon}
        <span className="update-banner-title">{title}</span>{" "}
        <span className="update-banner-subtext">{subtext}</span>
      </button>
      {onDismiss && (
        <button
          type="button"
          className="update-banner-dismiss"
          // Its own name, independent of the tooltip; the "×" is hidden.
          aria-label={dismissTitle ?? "Dismiss"}
          title={dismissTitle}
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
        >
          <span aria-hidden="true">×</span>
        </button>
      )}
    </div>
  );
}
