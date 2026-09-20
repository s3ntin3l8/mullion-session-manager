// WebSocket hook for system image install/uninstall operations. Manages the
// WS lifecycle, accumulates progress lines, and surfaces done/error states.

import { useCallback, useEffect, useRef, useState } from "react";

type Status = "idle" | "running" | "done" | "error";

interface UseSystemImageInstallReturn {
  install: (packagePath: string) => void;
  uninstall: (packagePath: string) => void;
  status: Status;
  progress: string[];
  error: string | null;
  reset: () => void;
}

export function useSystemImageInstall(): UseSystemImageInstallReturn {
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const cleanup = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const startOperation = useCallback(
    (message: { type: string; packagePath: string }) => {
      cleanup();
      setStatus("running");
      setProgress([]);
      setError(null);

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/system-image-install`);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify(message));
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

  const install = useCallback(
    (packagePath: string) => startOperation({ type: "install", packagePath }),
    [startOperation],
  );

  const uninstall = useCallback(
    (packagePath: string) => startOperation({ type: "uninstall", packagePath }),
    [startOperation],
  );

  const reset = useCallback(() => {
    cleanup();
    setStatus("idle");
    setProgress([]);
    setError(null);
  }, [cleanup]);

  // Close the socket on unmount so the server-side op isn't left running
  // while the component that owns it is gone (e.g. tab-switch in Settings).
  useEffect(() => cleanup, [cleanup]);

  return { install, uninstall, status, progress, error, reset };
}
