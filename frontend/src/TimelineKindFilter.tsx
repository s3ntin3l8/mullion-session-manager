import { useEffect, useId, useRef, useState } from "react";
import { ALL_KINDS, KIND_LABELS } from "./eventDescriptions.js";
import {
  IMPORTANT_KINDS,
  KIND_GROUPS,
  KIND_OPTION_LABELS,
  timelinePreset,
} from "./timelineKinds.js";
import type { TimelineKind } from "./timelineKinds.js";

/**
 * The timeline's kind filter: a preset switch (Important · All · Custom) and,
 * behind Custom, a popover grouping every kind plus the subagent isolate
 * chips. Replaces ~26 always-visible chips over five rows.
 *
 * Important and All set the selection outright; Custom only opens the popover
 * (it never changes the selection by itself). The preset shown is derived from
 * the selection (timelinePreset), so a hand-picked set that happens to equal
 * Important or All reads as that preset.
 *
 * A disclosure like ui/ProjectMultiSelect, not a menu: the panel holds toggle
 * buttons. Escape and a click outside close it.
 */
export function TimelineKindFilter({
  activeKinds,
  onChange,
  agentOptions,
  activeAgentKeys,
  onToggleAgent,
}: {
  activeKinds: ReadonlySet<TimelineKind>;
  onChange: (next: Set<TimelineKind>) => void;
  agentOptions: ReadonlyArray<{ key: string; label: string }>;
  activeAgentKeys: ReadonlySet<string>;
  onToggleAgent: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const customRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const preset = timelinePreset(activeKinds);
  // Selected subagent chips narrow the list but live inside the popover, so
  // the closed switch has to say so — a hidden filter would otherwise make
  // rows vanish with nothing on screen to explain it.
  const isolatedAgents = agentOptions.filter((o) => activeAgentKeys.has(o.key)).length;

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  const setGroup = (kinds: readonly TimelineKind[], on: boolean) => {
    const next = new Set(activeKinds);
    for (const kind of kinds) {
      if (on) next.add(kind);
      else next.delete(kind);
    }
    onChange(next);
  };
  const toggle = (kind: TimelineKind) => {
    const next = new Set(activeKinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    onChange(next);
  };

  return (
    <div
      className="session-timeline-presets"
      ref={rootRef}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
          customRef.current?.focus();
        }
      }}
    >
      <div className="session-timeline-preset-switch" role="group" aria-label="Kind filter preset">
        <button
          type="button"
          className={`session-timeline-kind-chip${preset === "important" ? " active" : ""}`}
          aria-pressed={preset === "important"}
          onClick={() => onChange(new Set(IMPORTANT_KINDS))}
        >
          Important
        </button>
        <button
          type="button"
          className={`session-timeline-kind-chip${preset === "all" ? " active" : ""}`}
          aria-pressed={preset === "all"}
          onClick={() => onChange(new Set(ALL_KINDS))}
        >
          All
        </button>
        <button
          ref={customRef}
          type="button"
          className={`session-timeline-kind-chip${preset === "custom" || open ? " active" : ""}`}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => setOpen((v) => !v)}
        >
          Custom{isolatedAgents > 0 ? ` · ${isolatedAgents} agent` : ""} ▾
        </button>
      </div>
      {open && (
        <div
          className="session-timeline-kind-popover"
          id={panelId}
          role="group"
          aria-label="Filter by kind"
        >
          {KIND_GROUPS.map((group) => (
            <div key={group.id} className="session-timeline-kind-group">
              <div className="session-timeline-kind-group-head">
                <span>{group.label}</span>
                <button
                  type="button"
                  className="session-timeline-kind-group-action"
                  aria-label={`Show every ${group.label} kind`}
                  onClick={() => setGroup(group.kinds, true)}
                >
                  all
                </button>
                <button
                  type="button"
                  className="session-timeline-kind-group-action"
                  aria-label={`Hide every ${group.label} kind`}
                  onClick={() => setGroup(group.kinds, false)}
                >
                  none
                </button>
              </div>
              <div className="session-timeline-kinds">
                {group.kinds.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className={`session-timeline-kind-chip${activeKinds.has(kind) ? " active" : ""}`}
                    aria-pressed={activeKinds.has(kind)}
                    onClick={() => toggle(kind)}
                  >
                    {KIND_OPTION_LABELS[kind] ?? KIND_LABELS[kind]}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {agentOptions.length > 0 && (
            <div className="session-timeline-kind-group">
              <div className="session-timeline-kind-group-head">
                <span>Subagent</span>
                <span className="session-timeline-kind-group-hint">isolate one agent's events</span>
              </div>
              <div className="session-timeline-agents" role="group" aria-label="Filter by subagent">
                {agentOptions.map(({ key, label }) => (
                  <button
                    key={key}
                    type="button"
                    className={`session-timeline-kind-chip${activeAgentKeys.has(key) ? " active" : ""}`}
                    aria-pressed={activeAgentKeys.has(key)}
                    title={key}
                    onClick={() => onToggleAgent(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
