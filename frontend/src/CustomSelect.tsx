import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  menuPlacement = "bottom",
  menuAlign = "left",
}: {
  value: string;
  onChange: (value: string) => void;
  options: CustomSelectOption[];
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  label?: string;
  menuPlacement?: "bottom" | "top";
  menuAlign?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      const outsideContainer = ref.current && !ref.current.contains(target);
      const outsideMenu = menuRef.current && !menuRef.current.contains(target);
      if (outsideContainer && outsideMenu) {
        setOpen(false);
        setFocusedIndex(-1);
        setTriggerRect(null);
      }
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  useEffect(() => {
    if (open && focusedIndex >= 0) {
      const item = menuRef.current?.querySelector(
        `[data-index="${focusedIndex}"]`,
      ) as HTMLElement | null;
      item?.scrollIntoView?.({ block: "nearest" });
    }
  }, [open, focusedIndex]);

  useEffect(() => {
    if (!open) return;
    function handleExternalEvent() {
      setOpen(false);
      setFocusedIndex(-1);
      setTriggerRect(null);
    }
    window.addEventListener("scroll", handleExternalEvent, true);
    window.addEventListener("resize", handleExternalEvent);
    return () => {
      window.removeEventListener("scroll", handleExternalEvent, true);
      window.removeEventListener("resize", handleExternalEvent);
    };
  }, [open]);

  const selectedIndex = useMemo(
    () => options.findIndex((o) => o.value === value),
    [options, value],
  );
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  function openMenu() {
    setOpen(true);
    setFocusedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setTriggerRect(triggerRef.current?.getBoundingClientRect() ?? null);
  }

  function closeMenu() {
    setOpen(false);
    setFocusedIndex(-1);
    setTriggerRect(null);
    triggerRef.current?.focus();
  }

  function moveFocus(delta: number) {
    if (options.length === 0) return;
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

  function getMenuStyle(): React.CSSProperties {
    const rect = triggerRect;
    if (!rect) return {};
    const style: React.CSSProperties = {
      position: "fixed",
      minWidth: Math.max(140, rect.width),
    };
    if (menuPlacement === "top") {
      style.bottom = window.innerHeight - rect.top + 4;
    } else {
      style.top = rect.bottom + 4;
    }
    if (menuAlign === "right") {
      style.right = window.innerWidth - rect.right;
    } else {
      style.left = rect.left;
    }
    return style;
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
        aria-controls={listboxId}
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
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={listboxId}
            className="custom-select-menu"
            style={getMenuStyle()}
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
          </div>,
          document.body,
        )}
    </div>
  );
}
