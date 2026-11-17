import { useRef, useState } from "react";
import type { Host, Project } from "../api/index.js";
import { describeError } from "../lib/describeError.js";
import { useDashboardStore } from "../store/index.js";
import { pullReasonMessage } from "./gitReasons.js";

/** Extra checkouts have no primary-checkout status: let their host report pull refusals. */
export function useHostPull(project: Project | undefined, hosts: Host[]) {
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const inFlight = useRef(new Set<string>());
  const targets = Object.entries(project?.hostCwds ?? {})
    .filter(([id, cwd]) => id !== project?.hostId && cwd.trim() !== "")
    .map(([id, cwd]) => {
      const host = hosts.find((h) => h.id === id);
      const unavailable = !host
        ? "Host information unavailable"
        : host.drained
          ? "Host is drained"
          : host.health === "offline" || host.health === "pending"
            ? "Host is offline"
            : null;
      const key = JSON.stringify([project!.id, id, cwd]);
      return { id, cwd, key, name: host?.name ?? id, unavailable, pending: !!pending[key] };
    });

  const pull = async (hostId: string) => {
    const target = targets.find((t) => t.id === hostId);
    if (!project || !target || target.unavailable || inFlight.current.has(target.key)) return;
    const { key } = target;
    inFlight.current.add(key);
    setPending((p) => ({ ...p, [key]: true }));
    setMessages((m) => ({ ...m, [key]: "" }));
    try {
      const result = await useDashboardStore
        .getState()
        .pullProjectGit(project.id, undefined, hostId);
      const message =
        result.pulled && result.reason !== "already-up-to-date"
          ? "Pulled successfully."
          : pullReasonMessage(result.reason, result.detail);
      setMessages((m) => ({ ...m, [key]: message }));
    } catch (err) {
      setMessages((m) => ({ ...m, [key]: describeError(err, "Pull failed — try again.") }));
    } finally {
      inFlight.current.delete(key);
      setPending((p) => ({ ...p, [key]: false }));
    }
  };

  return { targets, pull, messages };
}
