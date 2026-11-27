import { useCallback, useEffect, useRef, useState } from "react";

export const ARM_CONFIRM_SECONDS = 3;

/**
 * Two-step arm-then-confirm state keyed by item/target id.
 * Arms a key for `seconds` (default 3s) against a wall-clock deadline, ticking
 * `secondsLeft` down once per second and auto-disarming on expiry or unmount.
 */
export function useArmConfirm(seconds = ARM_CONFIRM_SECONDS) {
  const [armedKey, setArmedKey] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(seconds);
  const deadlineRef = useRef<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    deadlineRef.current = null;
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const disarm = useCallback(() => {
    clearTimer();
    setArmedKey(null);
    setSecondsLeft(seconds);
  }, [clearTimer, seconds]);

  const arm = useCallback(
    (key: string) => {
      clearTimer();
      deadlineRef.current = Date.now() + seconds * 1000;
      setArmedKey(key);
      setSecondsLeft(seconds);
      intervalRef.current = setInterval(() => {
        const remaining =
          deadlineRef.current === null ? 0 : Math.ceil((deadlineRef.current - Date.now()) / 1000);
        if (remaining <= 0) {
          clearTimer();
          setArmedKey(null);
          setSecondsLeft(seconds);
        } else {
          setSecondsLeft(remaining);
        }
      }, 1000);
    },
    [clearTimer, seconds],
  );

  // Re-check the wall-clock deadline at click time so a throttled/frozen tab
  // cannot confirm after the arm window has already elapsed.
  const confirm = useCallback(
    (key: string): boolean => {
      if (armedKey !== key) return false;
      if (deadlineRef.current === null || Date.now() >= deadlineRef.current) {
        disarm();
        return false;
      }
      disarm();
      return true;
    },
    [armedKey, disarm],
  );

  return { armedKey, secondsLeft, arm, disarm, confirm };
}
