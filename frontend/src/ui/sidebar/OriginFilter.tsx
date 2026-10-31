import type { OriginFilterValue } from "../../github/rowOrigin.js";

const OPTIONS: Array<{ value: OriginFilterValue; label: string }> = [
  { value: "all", label: "All" },
  { value: "tm", label: "Task Master" },
  { value: "manual", label: "Manual" },
];

/** All / Task Master / Manual, in a section header: who is working these rows. */
export function OriginFilter({
  value,
  onChange,
  label,
}: {
  value: OriginFilterValue;
  onChange: (next: OriginFilterValue) => void;
  label: string;
}) {
  return (
    <div className="sb-seg" role="group" aria-label={label}>
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          className={value === o.value ? "on" : undefined}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
