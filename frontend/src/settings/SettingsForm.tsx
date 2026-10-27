import type { ReactNode } from "react";
import { GroupHeading } from "../ui/primitives.js";

/** Opt-in layout: existing Settings sections keep their own presentation. */
export function SettingsForm({ children }: { children: ReactNode }) {
  return <div className="settings-form">{children}</div>;
}

export function SettingsGroup({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="settings-form-group" aria-label={title}>
      <GroupHeading title={title} desc={desc} />
      {children}
    </section>
  );
}

export function SettingsHelp({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <>
      {summary}
      <details className="settings-form-help">
        <summary>More details</summary>
        {children}
      </details>
    </>
  );
}
