import { useEffect, useMemo, useRef, useState } from "react";
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
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  options: CustomSelectOption[];
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  useEffect(() => {
    if (open && focusedIndex >= 0) {
      const item = ref.current?.querySelector(
        `[data-index="${focusedIndex}"]`,
      ) as HTMLElement | null;
      item?.scrollIntoView?.({ block: "nearest" });
    }
  }, [open, focusedIndex]);

  const selectedIndex = useMemo(
    () => options.findIndex((o) => o.value === value),
    [options, value],
  );
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  function openMenu() {
    setOpen(true);
    setFocusedIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }

  function closeMenu() {
    setOpen(false);
    setFocusedIndex(-1);
    triggerRef.current?.focus();
  }

  function moveFocus(delta: number) {
    setFocusedIndex((prev) => {
      if (prev < 0) return 0;
      return (prev + delta + options.length) % options.length;
    });
  }

  function selectOption(optValue: string) {
    onChange(optValue);
    closeMenu();
  }

  function handleTriggerKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) {
        openMenu();
      } else {
        moveFocus(1);
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setFocusedIndex(selectedIndex >= 0 ? selectedIndex : options.length - 1);
      } else {
        moveFocus(-1);
      }
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (open && focusedIndex >= 0 && focusedIndex < options.length) {
        selectOption(options[focusedIndex].value);
      } else {
        openMenu();
      }
      return;
    }
    if (e.key === "Tab") {
      closeMenu();
      return;
    }
  }

  function handleTriggerClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (open) {
      closeMenu();
    } else {
      openMenu();
    }
  }

  function handleOptionClick(e: React.MouseEvent, optValue: string) {
    e.stopPropagation();
    selectOption(optValue);
  }

  return (
    <div ref={ref} className={`custom-select ${className}`}>
      <button
        ref={triggerRef}
        className="custom-select-trigger"
        disabled={disabled}
        onClick={handleTriggerClick}
        onKeyDown={handleTriggerKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        aria-activedescendant={
          open && focusedIndex >= 0 ? `custom-select-opt-${focusedIndex}` : undefined
        }
        data-selected-value={value}
        type="button"
      >
        <span className="custom-select-label">{selected?.label ?? placeholder}</span>
        <ChevronDownIcon size={11} />
      </button>
      <div
        className={`custom-select-menu${open ? "" : " hidden"}`}
        role="listbox"
        onClick={(e) => e.stopPropagation()}
      >
        {options.map((opt, i) => (
          <button
            key={opt.value}
            id={`custom-select-opt-${i}`}
            className={`custom-select-item${opt.value === value ? " active" : ""}${i === focusedIndex ? " focused" : ""}`}
            role="option"
            aria-selected={opt.value === value}
            tabIndex={-1}
            data-value={opt.value}
            data-index={i}
            onClick={(e) => handleOptionClick(e, opt.value)}
            type="button"
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
