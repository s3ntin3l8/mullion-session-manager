import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "./icons.js";

export interface CustomSelectOption {
  value: string;
  label: string;
}

export function CustomSelect({
  value,
  onChange,
  options,
  disabled = false,
  className = "",
  placeholder = "",
}: {
  value: string;
  onChange: (value: string) => void;
  options: CustomSelectOption[];
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const selected = options.find((o) => o.value === value);

  return (
    <div ref={ref} className={`custom-select ${className}`}>
      <button
        className="custom-select-trigger"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-selected-value={value}
        type="button"
      >
        <span className="custom-select-label">{selected?.label ?? placeholder}</span>
        <ChevronDownIcon size={11} />
      </button>
      <div className={`custom-select-menu${open ? "" : " hidden"}`} role="listbox">
        {options.map((opt) => (
          <button
            key={opt.value}
            className={`custom-select-item${opt.value === value ? " active" : ""}`}
            role="option"
            aria-selected={opt.value === value}
            data-value={opt.value}
            onClick={(e) => {
              e.stopPropagation();
              onChange(opt.value);
              setOpen(false);
            }}
            type="button"
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
