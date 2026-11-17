// Drives the shared `Dropdown` (ui/primitives.tsx) from a test on either of
// its paths (#3245): the styled list a fine pointer gets (a `role="combobox"`
// button that opens a portaled listbox) and the native <select> a coarse
// pointer keeps. A test reads and picks through these instead of
// `selectOptions`/`getByDisplayValue`, which only know the native one.
import { act, fireEvent, waitFor } from "@testing-library/react";

export interface DropdownOptionInfo {
  value: string;
  label: string;
  disabled: boolean;
}

function isNative(field: HTMLElement): field is HTMLSelectElement {
  return field instanceof HTMLSelectElement;
}

// The value the field holds, read as a native select reports it: a value
// that matches none of the options reads as the first option's, which is
// also what the closed field shows. So "the value is X" still fails for an X
// the dropdown does not offer.
export function dropdownValue(field: HTMLElement): string {
  if (isNative(field)) return field.value;
  const value = field.getAttribute("data-value") ?? "";
  const offered = [...field.querySelectorAll<HTMLElement>(".ui-dropdown-sizer > span")].map(
    (s) => s.dataset.value ?? "",
  );
  return offered.includes(value) ? value : (offered[0] ?? "");
}

// The label the closed field shows.
export function dropdownLabel(field: HTMLElement): string {
  if (isNative(field)) return field.selectedOptions[0]?.textContent ?? "";
  return field.querySelector(".ui-dropdown-current")?.textContent ?? "";
}

// Opens the styled list (no-op when already open) and returns the listbox.
export function openDropdown(field: HTMLElement): HTMLElement {
  if (isNative(field)) throw new Error("openDropdown: a native <select> has no styled list");
  if (field.getAttribute("aria-expanded") !== "true") {
    act(() => {
      fireEvent.mouseDown(field, { button: 0 });
    });
  }
  const listbox = document.getElementById(field.getAttribute("aria-controls") ?? "");
  if (!listbox) throw new Error("openDropdown: the list did not open");
  return listbox;
}

export function closeDropdown(field: HTMLElement): void {
  if (isNative(field) || field.getAttribute("aria-expanded") !== "true") return;
  act(() => {
    fireEvent.keyDown(field, { key: "Escape" });
  });
}

// Every option the field offers, the action row excluded. Leaves a styled
// list closed, as it found it.
export function dropdownOptions(field: HTMLElement): DropdownOptionInfo[] {
  if (isNative(field)) {
    return [...field.options].map((o) => ({
      value: o.value,
      label: o.textContent ?? "",
      disabled: o.disabled,
    }));
  }
  const wasOpen = field.getAttribute("aria-expanded") === "true";
  const listbox = openDropdown(field);
  const options = [
    ...listbox.querySelectorAll<HTMLElement>('[role="option"]:not([data-action])'),
  ].map((o) => ({
    value: o.getAttribute("data-value") ?? "",
    label: o.getAttribute("aria-label") ?? o.textContent ?? "",
    disabled: o.getAttribute("aria-disabled") === "true",
  }));
  if (!wasOpen) closeDropdown(field);
  return options;
}

// Picks the option whose value or label is `valueOrLabel` (the match
// `userEvent.selectOptions` makes), as a user would on either path.
export function pickDropdownOption(field: HTMLElement, valueOrLabel: string): void {
  if (isNative(field)) {
    const option = [...field.options].find(
      (o) => o.value === valueOrLabel || o.textContent === valueOrLabel,
    );
    if (!option) throw new Error(`pickDropdownOption: no option "${valueOrLabel}"`);
    act(() => {
      fireEvent.change(field, { target: { value: option.value } });
    });
    return;
  }
  const listbox = openDropdown(field);
  const option = [...listbox.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (o) =>
      (!o.hasAttribute("data-action") && o.getAttribute("data-value") === valueOrLabel) ||
      o.getAttribute("aria-label") === valueOrLabel ||
      o.textContent === valueOrLabel,
  );
  if (!option) throw new Error(`pickDropdownOption: no option "${valueOrLabel}"`);
  act(() => {
    fireEvent.click(option);
  });
}

// Every Dropdown field under `root`, on either path.
export function allDropdowns(root: ParentNode = document.body): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(".ui-dropdown-field")];
}

// The Dropdown showing `label` — `getByDisplayValue` for both paths.
export function getDropdownByLabel(label: string, root: ParentNode = document.body): HTMLElement {
  const found = allDropdowns(root).filter((f) => dropdownLabel(f) === label);
  if (found.length !== 1) {
    throw new Error(`getDropdownByLabel: ${found.length} dropdowns show "${label}"`);
  }
  return found[0]!;
}

export function queryDropdownByLabel(
  label: string,
  root: ParentNode = document.body,
): HTMLElement | null {
  return allDropdowns(root).find((f) => dropdownLabel(f) === label) ?? null;
}

export async function findDropdownByLabel(
  label: string,
  root: ParentNode = document.body,
): Promise<HTMLElement> {
  return waitFor(() => getDropdownByLabel(label, root));
}

// Waits until a Dropdown under `root` offers an option labelled `label` (the
// options load asynchronously) and returns every such field —
// `findAllByRole("option", { name })` for both paths.
export async function findDropdownsWithOption(
  label: string,
  root: ParentNode = document.body,
): Promise<HTMLElement[]> {
  return waitFor(() => {
    const found = allDropdowns(root).filter((f) =>
      dropdownOptions(f).some((o) => o.label === label),
    );
    if (found.length === 0) throw new Error(`no dropdown offers "${label}"`);
    return found;
  });
}
