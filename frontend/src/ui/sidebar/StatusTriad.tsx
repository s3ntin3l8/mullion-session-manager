import type { ReactNode } from "react";
import type { Tone } from "../../lib/statusTone.js";
import { StatusChip } from "./StatusChip.js";

export interface TriadItem {
  key: "ci" | "review" | "merge";
  tone: Tone;
  /** Full label, e.g. "CI failing". */
  label: ReactNode;
  /** Compact label, e.g. "✗1"; a plain-text `title` carries the full words. */
  short?: ReactNode;
  title?: string;
  onClick?: () => void;
}

export interface StatusTriadProps {
  items: readonly TriadItem[];
  /** Key of the item whose drilldown is open. */
  openKey?: TriadItem["key"] | null;
}

/** CI, Review and Merge chips; each is a button that opens its drilldown. */
export function StatusTriad({ items, openKey }: StatusTriadProps) {
  return (
    <div className="sb-triad" role="group" aria-label="PR status">
      {items.map((it) => (
        <StatusChip
          key={it.key}
          tone={it.tone}
          short={it.short}
          title={it.title}
          onClick={it.onClick}
          pressed={it.onClick ? openKey === it.key : undefined}
          className={openKey === it.key ? "sb-chip--open" : undefined}
        >
          {it.label}
        </StatusChip>
      ))}
    </div>
  );
}
