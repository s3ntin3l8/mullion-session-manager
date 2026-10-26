import type { Session } from "../../api/index.js";
import { StatusChip } from "./StatusChip.js";

export interface ReviewGateChipProps {
  /** The linked sessions held at the gate (see gatedSessions). */
  sessions: readonly Session[];
}

/**
 * "review gate": a linked session is waiting on Mullion's PreToolUse review
 * gate (#2019). The tooltip carries what the agent is asking and what
 * releases it; renders nothing while no session waits.
 */
export function ReviewGateChip({ sessions }: ReviewGateChipProps) {
  if (sessions.length === 0) return null;
  const prompts = sessions.map((s) => {
    const name = s.name ?? `Session ${s.id}`;
    return s.gatePrompt ? `${name}: ${s.gatePrompt}` : name;
  });
  return (
    <StatusChip
      tone="warn"
      title={`${prompts.join("\n")}\nApprove or deny in the session or the notification bell`}
    >
      {sessions.length > 1 ? `review gate · ${sessions.length}` : "review gate"}
    </StatusChip>
  );
}
