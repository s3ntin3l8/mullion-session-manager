// Reusable Settings-modal control primitives — ported 1:1 from the
// reference design's SettingsBody.dc.html (see the plan's "Design — the
// shell" section for the full spec each of these was built against).
// Every section in Settings.tsx composes these instead of raw
// `<select>`/`<input>` elements.
//
// Moved out of settings/ — most importers are non-Settings components. The
// `settings-*` class-name prefix below is kept as historical: renaming 130
// `.settings-*` rules in styles.css for a file move is pure
// visual-regression risk for zero functional gain.
import { createContext, isValidElement, useContext, useId, useRef } from "react";
import type { ReactNode } from "react";

/**
 * The readable text of a Row's label.
 *
 * A Row's label is a ReactNode, and most of them are plain strings, but a
 * handful are JSX (the "Ctrl + R" key chips in InputSection, and the
 * `label={label}` pass-throughs in ModelPicker / RunwaySection /
 * ReviewRelaySection / ServerDefaultNumberRow, whose `label` is itself a
 * string prop). Walking the node gives the same text a screen reader would
 * read, without asking every caller to keep a string and a JSX version of
 * the same label in sync.
 */
function labelText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(labelText).join("");
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return labelText(props.children);
  }
  return "";
}

/**
 * What a control inside a Row needs in order to name itself.
 *
 * `labelId` is the id of the Row's *visible* label element, so a control can
 * point `aria-labelledby` straight at it and the visible text becomes the
 * accessible name — which is also what WCAG 2.5.3 "Label in Name" wants.
 * `name` is set only when the caller overrode the visible text with an
 * explicit `ariaLabel` (the key-chip rows in InputSection, whose visible
 * label is a keyboard shortcut rather than the setting's name); an explicit
 * name then takes precedence over `aria-labelledby`.
 *
 * A `<label for>` was deliberately not used here. The control lives in a
 * sibling subtree (`.settings-row-control`) rather than inside the label
 * element, so `for` could only work by way of a generated id, and not every
 * control is labelable at all — `Segmented` renders a
 * `<div role="radiogroup">`, for which `for` would be invalid HTML.
 * `aria-labelledby` references the same visible text and is valid for every
 * control type.
 */
type RowLabelContextValue = {
  labelId: string;
  name?: string;
};

const RowLabelContext = createContext<RowLabelContextValue | null>(null);

/**
 * The accessible-name props for a control inside a Row.
 *
 * Returns `aria-label` when there is an explicit name (the control's own
 * `ariaLabel` prop, or the Row's), and `aria-labelledby` pointing at the
 * visible label otherwise. A control that is neither inside a Row nor given
 * an explicit name gets neither — which is exactly the defect this whole
 * mechanism exists to prevent, so the a11y test asserts it does not happen.
 */
function useControlLabel(explicit?: string) {
  const row = useContext(RowLabelContext);
  const name = explicit?.trim() ? explicit : row?.name;
  return {
    "aria-label": name,
    "aria-labelledby": name ? undefined : row?.labelId,
  };
}

export function Row({
  label,
  desc,
  children,
  align = "center",
  ariaLabel,
}: {
  label: ReactNode;
  desc?: ReactNode;
  children: ReactNode;
  // Reference rows whose control sits beside a two-line description
  // (Theme, Terminal font) top-align instead of center-align.
  align?: "center" | "start";
  // Overrides the accessible name derived from the visible label. Needed
  // where the visible label is not the setting's name — e.g. the
  // key-conflict rows in InputSection, whose label is the "Ctrl + R" chip
  // and whose desc ("Reverse search") is what the setting is actually
  // called.
  ariaLabel?: string;
}) {
  const labelId = useId();
  const explicit = ariaLabel?.trim() ? ariaLabel : undefined;
  // The accessible name is the visible label's text, unless the caller
  // overrode it. Computing it here (rather than relying on
  // `aria-labelledby` alone) keeps the name stable even if the visible
  // label is later restyled or moved, and lets a control with an
  // icon-only label still fall back to `aria-labelledby`.
  const derived = labelText(label).trim();
  const ctx: RowLabelContextValue = { labelId, name: explicit ?? (derived || undefined) };
  return (
    <div className={`settings-row${align === "start" ? " align-start" : ""}`}>
      <div className="settings-row-text">
        <div className="settings-row-label" id={labelId}>
          {label}
        </div>
        {desc && <div className="settings-row-desc">{desc}</div>}
      </div>
      <div className="settings-row-control">
        <RowLabelContext.Provider value={ctx}>{children}</RowLabelContext.Provider>
      </div>
    </div>
  );
}

export function GroupHeading({ title, desc }: { title: ReactNode; desc?: ReactNode }) {
  return (
    <div className="settings-group-heading">
      <div className="settings-group-title">{title}</div>
      {desc && <div className="settings-group-desc">{desc}</div>}
    </div>
  );
}

export function Eyebrow({ title, desc }: { title: ReactNode; desc?: ReactNode }) {
  return (
    <div className="settings-eyebrow-block">
      <div className="settings-eyebrow">{title}</div>
      {desc && <div className="settings-eyebrow-desc">{desc}</div>}
    </div>
  );
}

export function Toggle({
  on,
  onChange,
  size = "default",
  testId,
  ariaLabel,
  disabled,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  size?: "default" | "small";
  // Same stable query hook as ListRow's own `testId` (Hermes review, PR
  // #36) — a Toggle's DOM shape is an implementation detail component
  // tests shouldn't couple to via class-name/`.closest()` queries.
  testId?: string;
  // Overrides the name the enclosing Row would otherwise supply. Leave it
  // off for a Row-hosted Toggle: the Row's visible label is then the
  // accessible name, which is what a screen reader needs to tell 30-odd
  // identical toggle buttons apart.
  ariaLabel?: string;
  // SkillsPanel, PR #469, round 4 — surfaces an in-flight toggle so it
  // can't be double-clicked into a racing second write, without needing
  // every caller to duplicate a disabled-state class/style.
  disabled?: boolean;
}) {
  const label = useControlLabel(ariaLabel);
  return (
    <button
      className={`settings-toggle${on ? " on" : ""}${size === "small" ? " small" : ""}`}
      onClick={() => onChange(!on)}
      aria-pressed={on}
      data-testid={testId}
      {...label}
      disabled={disabled}
    >
      <span className="settings-toggle-knob" />
    </button>
  );
}

/**
 * A segmented control, exposed as a radio group.
 *
 * The selection used to be carried by the `.active` CSS class alone, so a
 * screen reader heard a row of identical buttons with no indication of
 * which one was selected. `role="radiogroup"` + `role="radio"` +
 * `aria-checked` fixes that, and the arrow keys / Home / End move the
 * selection — which is the behaviour the radio role implies, so it is
 * implemented rather than half-announced.
 *
 * Only the selected radio is in the tab order (roving tabindex), per the
 * WAI-ARIA radio group pattern: one Tab stop for the whole group, arrows
 * to move within it.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: Array<{ value: T; label: ReactNode }>;
  value: T;
  onChange: (v: T) => void;
  // Overrides the name the enclosing Row would otherwise supply.
  ariaLabel?: string;
}) {
  const label = useControlLabel(ariaLabel);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = options.findIndex((o) => o.value === value);
  // If `value` matches no option, fall back to the first one for the tab
  // stop — otherwise every radio would be tabIndex={-1} and the group
  // would be unreachable by keyboard.
  const tabbableIndex = selectedIndex >= 0 ? selectedIndex : 0;
  // Which radio currently has focus. The arrow keys move relative to the
  // FOCUSED radio, not to `value`: this component is controlled, and a
  // parent that batches its state update would otherwise make two quick
  // arrow presses compute from the same stale `value` and jump two steps.
  const focusedRef = useRef(tabbableIndex);

  const select = (index: number) => {
    const opt = options[index];
    if (!opt) return;
    onChange(opt.value);
    // Focusing the new radio also updates focusedRef through its onFocus.
    refs.current[index]?.focus();
  };

  return (
    <div
      className="settings-segmented"
      role="radiogroup"
      {...label}
      onKeyDown={(e) => {
        if (options.length === 0) return;
        const current = focusedRef.current;
        switch (e.key) {
          case "ArrowRight":
          case "ArrowDown":
            e.preventDefault();
            select((current + 1) % options.length);
            break;
          case "ArrowLeft":
          case "ArrowUp":
            e.preventDefault();
            select((current - 1 + options.length) % options.length);
            break;
          case "Home":
            e.preventDefault();
            select(0);
            break;
          case "End":
            e.preventDefault();
            select(options.length - 1);
            break;
          default:
            break;
        }
      }}
    >
      {options.map((opt, i) => (
        <button
          key={opt.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={opt.value === value}
          tabIndex={i === tabbableIndex ? 0 : -1}
          className={`settings-segmented-btn${opt.value === value ? " active" : ""}`}
          onFocus={() => {
            focusedRef.current = i;
          }}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({
  min,
  max,
  step = 1,
  value,
  onChange,
  format,
  ariaLabel,
}: {
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
  // Overrides the name the enclosing Row would otherwise supply.
  ariaLabel?: string;
}) {
  const label = useControlLabel(ariaLabel);
  return (
    <div className="settings-slider-row">
      <input
        type="range"
        className="settings-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        {...label}
        // The raw number is meaningless without its unit ("12" vs "12 px"),
        // so the formatted text is what gets announced.
        aria-valuetext={format(value)}
      />
      {/* The bubble restates aria-valuetext visually; announcing it twice
          would just be noise. */}
      <span className="settings-slider-bubble" aria-hidden="true">
        {format(value)}
      </span>
    </div>
  );
}

export function NumberField({
  value,
  onChange,
  onCommit,
  suffix,
  width = 74,
  min,
  max,
  ariaLabel,
}: {
  value: number;
  onChange: (v: number) => void;
  // Optional: fires on blur/Enter instead of on every keystroke. Additive —
  // callers that omit it keep today's every-keystroke `onChange` behavior
  // unchanged. Lets a caller show live typing feedback via local draft state
  // while deferring the actual commit (e.g. a debounced settings PATCH)
  // until editing finishes, so a transient in-progress value (like a
  // momentarily-cleared field reading 0) never gets persisted.
  onCommit?: (v: number) => void;
  suffix: string;
  width?: number;
  min?: number;
  max?: number;
  // Overrides the name the enclosing Row would otherwise supply.
  ariaLabel?: string;
}) {
  const label = useControlLabel(ariaLabel);
  return (
    <div className="settings-numberfield">
      <input
        type="number"
        style={{ width }}
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isNaN(n)) onChange(n);
        }}
        onBlur={(e) => {
          if (!onCommit) return;
          const n = Number(e.target.value);
          if (!Number.isNaN(n)) onCommit(n);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        {...label}
        // The bare number means nothing without its unit, so the unit rides
        // along in the announced value.
        aria-valuetext={`${value}${suffix}`}
      />
      <span className="settings-numberfield-suffix" aria-hidden="true">
        {suffix}
      </span>
    </div>
  );
}

export function Dropdown<T extends string>({
  options,
  value,
  onChange,
  small = false,
  ariaLabel,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  small?: boolean;
  // Overrides the name the enclosing Row would otherwise supply.
  ariaLabel?: string;
}) {
  const label = useControlLabel(ariaLabel);
  return (
    <div className={`settings-dropdown${small ? " small" : ""}`}>
      <select value={value} onChange={(e) => onChange(e.target.value as T)} {...label}>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function ListRow({
  icon,
  dot,
  title,
  subtitle,
  trailing,
  unavailable = false,
  stacked = false,
  testId,
}: {
  icon?: ReactNode;
  // "warn" is additive (issue #246's degraded-host heartbeat state) — every
  // existing caller only ever passes "on"/"off"/undefined.
  dot?: "on" | "off" | "warn";
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  unavailable?: boolean;
  // Puts the subtitle on its own full-width line under the title (long
  // values like a system-image package path wrap instead of ellipsizing).
  // Additive — every existing caller leaves it off and keeps the one-line
  // side-by-side layout.
  stacked?: boolean;
  // Optional, stable query hook for tests — a row's DOM shape (which wraps
  // its title in an extra <span>, etc.) is an implementation detail
  // component tests shouldn't couple to via `.closest(".settings-list-row")`
  // (Hermes review, PR #36).
  testId?: string;
}) {
  return (
    <div
      className={`settings-list-row${unavailable ? " unavailable" : ""}${stacked ? " stacked" : ""}`}
      data-testid={testId}
    >
      {icon && <span className="settings-list-row-icon">{icon}</span>}
      {dot && <span className={`settings-status-dot ${dot}`} />}
      <span className="settings-list-row-title">{title}</span>
      {subtitle && <span className="settings-list-row-subtitle">{subtitle}</span>}
      {trailing && <span className="settings-list-row-trailing">{trailing}</span>}
    </div>
  );
}

export function StyledList({ children }: { children: ReactNode }) {
  return <div className="settings-list">{children}</div>;
}

export function SecondaryButton({
  onClick,
  icon,
  children,
  disabled,
}: {
  onClick: () => void;
  icon?: ReactNode;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button className="settings-secondary-btn" onClick={onClick} disabled={disabled}>
      {icon}
      {children}
    </button>
  );
}

export function AddButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button className="settings-add-btn" onClick={onClick}>
      {children}
    </button>
  );
}
