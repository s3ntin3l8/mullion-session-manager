import { useEffect, useState } from "react";
import { api } from "../api/index.js";

// Whether the server runs the agent's browser at all (BROWSER_ENABLED). Null
// until the server answers; the switch stays hidden until then, the same as
// when the answer is no.
export function useBrowserFeatureEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .getServerInfo()
      .then((info) => {
        if (!cancelled) setEnabled(Boolean(info.features?.browser));
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return enabled;
}
