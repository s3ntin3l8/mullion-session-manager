import { useEffect, useState } from "react";
import { api } from "../api/index.js";
import type { ServerInfo } from "../api/index.js";

// Fetches /api/server-info once per mount. Null until loaded or on error;
// callers fall back to FALLBACK_RUNTIME_ENV for display.
export function useServerInfo(): ServerInfo | null {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .getServerInfo()
      .then((next) => {
        if (!cancelled) setInfo(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return info;
}
