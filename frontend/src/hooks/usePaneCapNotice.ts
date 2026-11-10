/* eslint-disable react-hooks/exhaustive-deps -- dependency arrays are the
   original App.tsx arrays. Passed-in refs and useState setters are stable
   and were not listed there; adding them would not change when the effect
   runs. */
import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";

// Issue #1555 — long enough to read, short enough not to sit on the grid.
const PANE_CAP_NOTICE_MS = 6000;

// Extracted from App.tsx (issue #2407). The hook is called at the effect's
// original position so its order among App's other effects is unchanged.
// The effect body, dependency array, and any eslint-disable inside it are
// the original text.

export interface UsePaneCapNoticeParams {
  paneCapNotice: boolean;
  setPaneCapNotice: Dispatch<SetStateAction<boolean>>;
}

export function usePaneCapNotice({
  paneCapNotice,
  setPaneCapNotice,
}: UsePaneCapNoticeParams): void {
  useEffect(() => {
    if (!paneCapNotice) return;
    const timer = setTimeout(() => setPaneCapNotice(false), PANE_CAP_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [paneCapNotice]);
}
