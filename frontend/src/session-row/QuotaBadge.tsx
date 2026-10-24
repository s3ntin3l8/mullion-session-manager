import type { RunwayQuota } from "../api/index.js";
import { commandToBinary } from "../cliLogos.js";
import {
  runwayQuotaDotClass,
  summarizeRunwayQuota,
  type RunwayQuotaSummary,
} from "../lib/sidebarStatus.js";
import { commandModelCli } from "../models/modelCatalogs.js";

// Issue #29 — the Runway quota chip on a session row.
//
// The chip reports what RUNWAY knows about the row's agent's provider, and
// it renders NOTHING unless there is real information to show: an
// unconfigured feature, a fetch that failed (no snapshot at all) and an
// agent Runway says nothing about all render nothing. A missing reading is
// never dressed up as a reassuring "OK" — "no information" is exactly what
// an operator must not mistake for "everything is fine".
//
// The snapshot itself is fetched ONCE for the whole app (see
// hooks/useRunwayQuota.ts); this component only reads it.

// The names a session's command can be known by in the Runway provider map:
// the CLI name ("claude-code") and the bare binary ("claude"). The map is a
// per-install decision — the backend's own default map names the binary —
// so BOTH are looked up, CLI name first, and the first one Runway reports
// wins.
function agentKeys(command: string): string[] {
  const keys: string[] = [];
  const cli = commandModelCli(command);
  if (cli !== null) keys.push(cli);
  const binary = commandToBinary(command);
  if (binary !== "" && !keys.includes(binary)) keys.push(binary);
  return keys;
}

export function QuotaBadge({
  quota,
  command,
}: {
  quota: RunwayQuota | null;
  // The session's launch command — the same value the row's agent logo and
  // name are derived from (see cliLogos.ts), so the badge names the same
  // agent the rest of the row names.
  command: string | null;
}) {
  if (quota === null || !quota.configured || quota.fetchedAt === null) return null;
  if (command === null) return null;

  let summary: RunwayQuotaSummary | null = null;
  for (const agent of agentKeys(command)) {
    const candidate = summarizeRunwayQuota(quota.agents, agent);
    if (candidate !== null) {
      summary = candidate;
      break;
    }
  }
  if (summary === null) return null;

  const dotClass = runwayQuotaDotClass(summary);
  const label = summary.out
    ? "quota out"
    : summary.pctUsed === null
      ? "quota ?"
      : `quota ${Math.round(summary.pctUsed)}%`;
  const title = summary.out
    ? `Runway: ${summary.providerId} is out of quota — Mullion will not claim a task onto ${summary.agent}.`
    : summary.pctUsed === null
      ? `Runway: no usage percentage reported for ${summary.providerId}.`
      : `Runway: ${Math.round(summary.pctUsed)}% of the ${summary.providerId} quota used.`;

  return (
    <span className="session-quota-chip" title={title} data-testid="quota-badge">
      <span className={`github-panel-ci-dot ${dotClass}`} />
      {label}
    </span>
  );
}
