// Reusable Settings-modal control primitives — ported 1:1 from the
// reference design's SettingsBody.dc.html (see the plan's "Design — the
// shell" section for the full spec each of these was built against).
// Every section in Settings.tsx composes these instead of raw
// `<select>`/`<input>` elements.
import type { ReactNode } from "react";

export function Row({
  label,
  desc,
  children,
  align = "center",
}: {
  label: ReactNode;
  desc?: ReactNode;
  children: ReactNode;
  // Reference rows whose control sits beside a two-line description
  // (Theme, Terminal font) top-align instead of center-align.
  align?: "center" | "start";
}) {
  return (
    <div className={`settings-row${align === "start" ? " align-start" : ""}`}>
      <div className="settings-row-text">
        <div className="settings-row-label">{label}</div>
        {desc && <div className="settings-row-desc">{desc}</div>}
      </div>
      <div className="settings-row-control">{children}</div>
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
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  size?: "default" | "small";
}) {
  return (
    <button
      className={`settings-toggle${on ? " on" : ""}${size === "small" ? " small" : ""}`}
      onClick={() => onChange(!on)}
      aria-pressed={on}
    >
      <span className="settings-toggle-knob" />
    </button>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: ReactNode }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="settings-segmented">
      {options.map((opt) => (
        <button
          key={opt.value}
          className={`settings-segmented-btn${opt.value === value ? " active" : ""}`}
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
}: {
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
}) {
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
      />
      <span className="settings-slider-bubble">{format(value)}</span>
    </div>
  );
}

export function NumberField({
  value,
  onChange,
  suffix,
  width = 74,
  min,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  suffix: string;
  width?: number;
  min?: number;
  max?: number;
}) {
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
      />
      <span className="settings-numberfield-suffix">{suffix}</span>
    </div>
  );
}

export function Dropdown<T extends string>({
  options,
  value,
  onChange,
  small = false,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  small?: boolean;
}) {
  return (
    <div className={`settings-dropdown${small ? " small" : ""}`}>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
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
}: {
  icon?: ReactNode;
  dot?: "on" | "off";
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  unavailable?: boolean;
}) {
  return (
    <div className={`settings-list-row${unavailable ? " unavailable" : ""}`}>
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
