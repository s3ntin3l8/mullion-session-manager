// WebSocket hook for SDK license acceptance. Manages the WS lifecycle,
// accumulates progress lines, and surfaces done/error states.

import { useCallback, useRef, useState } from "react";

type Status = "idle" | "running" | "done" | "error";

interface UseSdkLicensesReturn {
  accept: (onComplete?: () => void) => void;
  status: Status;
  progress: string[];
  error: string | null;
  reset: () => void;
}

export function useSdkLicenses(): UseSdkLicensesReturn {
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const onCompleteRef = useRef<(() => void) | null>(null);

  const cleanup = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const accept = useCallback(
    (onComplete?: () => void) => {
      cleanup();
      setStatus("running");
      setProgress([]);
      setError(null);
      onCompleteRef.current = onComplete ?? null;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/sdk-licenses`);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "accept-licenses" }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data));
          switch (msg.type) {
            case "progress":
              setProgress((prev) => [...prev, msg.message]);
              break;
            case "done":
              setStatus("done");
              cleanup();
              onCompleteRef.current?.();
              onCompleteRef.current = null;
              break;
            case "error":
              setStatus("error");
              setError(msg.message);
              cleanup();
              break;
          }
        } catch {
          // Ignore malformed messages.
        }
      };

      ws.onerror = () => {
        setStatus("error");
        setError("WebSocket connection failed");
        cleanup();
      };

      ws.onclose = () => {
        wsRef.current = null;
      };
    },
    [cleanup],
  );

  const reset = useCallback(() => {
    cleanup();
    setStatus("idle");
    setProgress([]);
    setError(null);
  }, [cleanup]);

  return { accept, status, progress, error, reset };
}
