import type { RunwayQuota } from "../api/index.js";
import { commandToBinary } from "../cliLogos.js";
import {
  runwayQuotaDotClass,
  runwayReadingAge,
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
//
// Issue #2054 — an opencode session spends the quota of the opencode
// PROVIDER it runs (`opencode/<provider>`, from its `provider/model`), so
// those targets are looked up too. The claim gate holds a task when ANY of
// its targets is out, so the chip does the same for opencode (see
// pickSummary): the bare agent and the session's provider both count. A
// session with no model could run on any provider the map names, exactly as
// the gate treats it, so every `opencode/*` target Runway reports counts.
function agentKeys(
  command: string,
  model: string | null | undefined,
  reported: RunwayQuota["agents"],
): string[] {
  const keys: string[] = [];
  const cli = commandModelCli(command);
  const withModel = cli === "opencode" && model ? model.split("/")[0] : "";
  // The session's own provider is what it spends, so it leads; a session with
  // no model has no provider of its own, so the bare agent leads and the
  // providers Runway reports follow (they only matter when one is out).
  if (withModel !== "") keys.push(`opencode/${withModel}`);
  if (cli !== null) keys.push(cli);
  const binary = commandToBinary(command);
  if (binary !== "" && !keys.includes(binary)) keys.push(binary);
  if (cli === "opencode" && withModel === "") {
    for (const entry of reported) {
      if (entry.agent.startsWith("opencode/") && !keys.includes(entry.agent)) {
        keys.push(entry.agent);
      }
    }
  }
  return keys;
}

// Which reading the chip shows. For opencode the gate holds on ANY target,
// so a target that is out wins over one that is not; otherwise (and for
// every other agent) the first key Runway reports wins.
function pickSummary(
  keys: string[],
  agents: RunwayQuota["agents"],
  anyTarget: boolean,
): RunwayQuotaSummary | null {
  let first: RunwayQuotaSummary | null = null;
  for (const key of keys) {
    const candidate = summarizeRunwayQuota(agents, key);
    if (candidate === null) continue;
    if (!anyTarget) return candidate;
    if (candidate.out) return candidate;
    first ??= candidate;
  }
  return first;
}

export function QuotaBadge({
  quota,
  command,
  model,
}: {
  quota: RunwayQuota | null;
  // The session's launch command — the same value the row's agent logo and
  // name are derived from (see cliLogos.ts), so the badge names the same
  // agent the rest of the row names.
  command: string | null;
  // The session's resolved model (`provider/model`), when it has one.
  model?: string | null;
}) {
  if (quota === null || !quota.configured || quota.fetchedAt === null) return null;
  if (command === null) return null;

  const summary = pickSummary(
    agentKeys(command, model, quota.agents),
    quota.agents,
    commandModelCli(command) === "opencode",
  );
  if (summary === null) return null;

  const dotClass = runwayQuotaDotClass(summary);
  const label = summary.out
    ? "quota out"
    : summary.pctUsed === null
      ? "quota ?"
      : `quota ${Math.round(summary.pctUsed)}%`;
  // The reading's age travels with it. The snapshot is taken when the
  // server last polled Runway, so with polling off — or Runway
  // unreachable — it can be hours old while still being the last thing
  // known. Without the age the chip reads as live, and a stale reading
  // must never look fresh.
  const age = runwayReadingAge(quota.fetchedAt);
  const title = summary.out
    ? `Runway: ${summary.providerId} is out of quota — Mullion will not claim a task onto ${summary.agent}. Reading ${age}.`
    : summary.pctUsed === null
      ? `Runway: no usage percentage reported for ${summary.providerId}. Reading ${age}.`
      : `Runway: ${Math.round(summary.pctUsed)}% of the ${summary.providerId} quota used. Reading ${age}.`;

  return (
    <span className="session-quota-chip" title={title} data-testid="quota-badge">
      <span className={`github-panel-ci-dot ${dotClass}`} />
      {label}
    </span>
  );
}
