import { useEffect, useRef, useState } from "react";

export const ARM_CONFIRM_SECONDS = 3;

/**
 * Two-step arm-then-confirm state keyed by item/target id.
 * Arms a key for `seconds` (default 3s), ticking `secondsLeft` down once per
 * second and auto-disarming when the countdown reaches 0 or on unmount.
 */
export function useArmConfirm(seconds = ARM_CONFIRM_SECONDS) {
  const [armedKey, setArmedKey] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(seconds);
  // Mirrors secondsLeft so the interval callback can branch without calling
  // side effects inside a setState updater (which warns under StrictMode).
  const secondsRef = useRef(seconds);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  useEffect(() => clearTimer, []);

  const disarm = () => {
    clearTimer();
    setArmedKey(null);
    secondsRef.current = seconds;
    setSecondsLeft(seconds);
  };

  const arm = (key: string) => {
    clearTimer();
    setArmedKey(key);
    secondsRef.current = seconds;
    setSecondsLeft(seconds);
    intervalRef.current = setInterval(() => {
      secondsRef.current -= 1;
      if (secondsRef.current <= 0) {
        clearTimer();
        setArmedKey(null);
        secondsRef.current = seconds;
        setSecondsLeft(seconds);
      } else {
        setSecondsLeft(secondsRef.current);
      }
    }, 1000);
  };

  return { armedKey, secondsLeft, arm, disarm };
}
