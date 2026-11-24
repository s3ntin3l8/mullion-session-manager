import { useRef, useState } from "react";
import type { IosSimulator } from "../../api/index.js";
import { SearchInput, SecondaryButton } from "../../ui/primitives.js";
import { viewSimulators } from "./simulatorList.js";

/**
 * Picks the simulator to add (Settings -> Devices, iOS Simulator). Xcode
 * provisions a default set per installed runtime, so the full list is long and
 * mostly never-used: it opens on the simulators someone uses (booted, already
 * added, or booted before), grouped by runtime with the newest first, with
 * "Show all" and a search for the rest.
 */
export function SimulatorPicker({
  simulators,
  activeUdids,
  value,
  onChange,
}: {
  simulators: IosSimulator[];
  /** Simulators that are already an active device (not selectable again). A
   * stopped device does not count: adding it again is allowed. */
  activeUdids: ReadonlySet<string>;
  value: string;
  onChange: (udid: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const view = viewSimulators(simulators, { query, showAll, activeUdids, keepUdid: value });
  const searching = query.trim() !== "";
  const listRef = useRef<HTMLDivElement>(null);
  const selected = simulators.find((s) => s.udid === value);
  const selectedShown = view.groups.some((g) => g.simulators.some((s) => s.udid === value));

  // A radiogroup is one tab stop; the arrow keys move the choice, skipping rows
  // that cannot be chosen.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? -1
          : 0;
    if (step === 0) return;
    const rows = [
      ...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]:enabled') ?? []),
    ];
    if (rows.length === 0) return;
    event.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = rows[(at + step + rows.length) % rows.length];
    next.focus();
    if (next.dataset.udid) onChange(next.dataset.udid);
  };
  // The row that takes the tab stop: the chosen one when it is on screen.
  const tabStop = selectedShown
    ? value
    : view.groups.flatMap((g) => g.simulators).find((s) => !activeUdids.has(s.udid))?.udid;

  return (
    <div className="sim-picker">
      <SearchInput
        small
        aria-label="Search simulators"
        placeholder="Search simulators…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div
        ref={listRef}
        role="radiogroup"
        aria-label="Simulator"
        className="sim-picker-list"
        onKeyDown={onKeyDown}
      >
        {view.groups.map((group) => (
          <div key={group.runtime} role="group" aria-label={group.runtime}>
            <div className="sim-picker-group">{group.runtime}</div>
            {group.simulators.map((sim) => {
              const added = activeUdids.has(sim.udid);
              const isSelected = sim.udid === value;
              return (
                <button
                  key={sim.udid}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  data-udid={sim.udid}
                  tabIndex={sim.udid === tabStop ? 0 : -1}
                  disabled={added}
                  className={`sim-picker-row${isSelected ? " selected" : ""}`}
                  onClick={() => onChange(sim.udid)}
                >
                  <span
                    className={`settings-status-dot ${sim.state === "Booted" ? "on" : "off"}`}
                    aria-hidden="true"
                  />
                  <span className="sim-picker-name">{sim.name}</span>
                  <span className="sim-picker-meta">
                    {added ? "already added" : sim.state.toLowerCase()}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
        {view.groups.length === 0 && (
          <div className="sim-picker-empty">No simulators match “{query.trim()}”.</div>
        )}
      </div>
      {/* Always mounted, so a screen reader that only announces into a live
          region it already knows says it when a search hides the choice. */}
      <div className="sim-picker-selected" aria-live="polite">
        {selected && !selectedShown ? `Selected: ${selected.name} (${selected.runtime})` : ""}
      </div>
      {!searching && (view.hidden > 0 || showAll) && view.total > 1 && (
        <SecondaryButton onClick={() => setShowAll((all) => !all)}>
          {showAll ? "Show used only" : `Show all ${view.total}`}
        </SecondaryButton>
      )}
    </div>
  );
}
