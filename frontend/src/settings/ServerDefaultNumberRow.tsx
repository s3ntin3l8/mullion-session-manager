import { useRef, useState } from "react";
import { NumberField, Row } from "../ui/primitives.js";
import { clampNumberFieldOnCommit } from "./clamp.js";

// A number setting whose stored value -1 means "use the server's default".
// Shows the effective value, commits on blur/Enter (so a half-typed value is
// never saved), and offers a one-click return to the server default while
// overridden.
export function ServerDefaultNumberRow({
  label,
  desc,
  value,
  serverDefault,
  min,
  max,
  suffix,
  width = 54,
  onChange,
}: {
  label: string;
  desc: string;
  value: number;
  serverDefault: number;
  min: number;
  max: number;
  suffix: string;
  width?: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  // NumberField reports an empty input as 0. Track emptiness separately so
  // clearing the field and leaving it reverts instead of saving `min` —
  // which for the heartbeat (min 0) would silently turn checks off.
  const emptyRef = useRef(false);
  const overridden = value !== -1;
  return (
    <Row
      label={label}
      desc={
        <>
          {desc} Server default: {serverDefault} {suffix}.
          {overridden && (
            <>
              {" "}
              <button
                type="button"
                className="settings-inline-link"
                onClick={() => {
                  setDraft(null);
                  onChange(-1);
                }}
              >
                Use server default
              </button>
            </>
          )}
        </>
      }
    >
      <div
        onInputCapture={(e) => {
          emptyRef.current = (e.target as HTMLInputElement).value.trim() === "";
        }}
      >
        <NumberField
          value={draft ?? (overridden ? value : serverDefault)}
          min={min}
          max={max}
          width={width}
          suffix={suffix}
          onChange={setDraft}
          onCommit={(v) => {
            // Blur without typing must not turn the displayed server default
            // into a saved override.
            if (draft === null) return;
            setDraft(null);
            if (emptyRef.current) {
              emptyRef.current = false;
              return;
            }
            onChange(clampNumberFieldOnCommit(v, min, max));
          }}
        />
      </div>
    </Row>
  );
}
