// Copy-paste commands for bringing an agent up against a host the primary
// already minted a token for (Settings -> Hosts -> Add host / Rotate token).
// The agent presents that token as its enrollment token; the primary matches
// it to the host row (host-registry.ts's claimHost) and fills in the agent's
// own URL, so no MULLION_ENROLLMENT_SECRET is needed on the primary.

const RELEASE_BASE =
  "https://github.com/s3ntin3l8/mullion-session-manager/releases/latest/download";

export interface AgentInstallParams {
  /** The per-host token the primary minted. */
  token: string;
  /** The primary's address as the AGENT can reach it (not necessarily the browser's). */
  primaryUrl: string;
  /** The host's name, used as the agent's registered name. */
  name: string;
  /** Where the primary reaches the agent; omitted, the agent reports its own. */
  baseUrl?: string;
}

// PowerShell single-quoted strings end at ' and also at its typographic
// look-alikes (U+2018, U+2019, U+201A, U+201B); inside the string each one is
// escaped by doubling it.
function ps(value: string): string {
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, (q) => q + q)}'`;
}

// POSIX single-quoted strings can't contain ', so close, escape, reopen.
function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function windowsInstallCommand(p: AgentInstallParams): string {
  const args = [
    `-PrimaryUrl ${ps(p.primaryUrl)}`,
    `-AgentName ${ps(p.name)}`,
    `-ProjectsRoots 'C:/Users/you/code'`,
    ...(p.baseUrl ? [`-AdvertiseUrl ${ps(p.baseUrl)}`] : []),
  ];
  return [
    `$env:MULLION_AGENT_ENROLLMENT_TOKEN = ${ps(p.token)}`,
    `& ([scriptblock]::Create((irm ${RELEASE_BASE}/mullion-install.ps1))) ${args.join(" ")}`,
  ].join("\n");
}

export function unixInstallCommand(p: AgentInstallParams): string {
  const env = [
    `MULLION_AGENT_PRIMARY_URL=${sh(p.primaryUrl)}`,
    `MULLION_AGENT_ENROLLMENT_TOKEN=${sh(p.token)}`,
    `MULLION_AGENT_NAME=${sh(p.name)}`,
    `MULLION_AGENT_PROJECTS_ROOTS="$HOME/code"`,
    ...(p.baseUrl ? [`MULLION_AGENT_ADVERTISE_URL=${sh(p.baseUrl)}`] : []),
  ];
  return [
    `curl -fsSL -o mullion-install.sh ${RELEASE_BASE}/mullion-install.sh`,
    `${env.join(" \\\n")} \\\n  sh mullion-install.sh --role agent "$HOME/mullion"`,
  ].join("\n");
}

/**
 * What an agent that registered itself (installed from the Add host command)
 * changes after a rotate. install.sh never rewrites an existing .env, so
 * re-running the installer would not apply the new token. The primary URL is
 * repeated so the enrollment path is complete before the static token is
 * cleared: an agent with neither path refuses to boot.
 */
export function envUpdateSnippet(token: string, primaryUrl: string): string {
  return [
    `MULLION_PRIMARY_URL=${primaryUrl}`,
    `MULLION_ENROLLMENT_TOKEN=${token}`,
    `MULLION_AGENT_TOKEN=`,
  ].join("\n");
}

/**
 * The same rotate for a host added with "Use my own token": that agent never
 * registers, the primary sends the row's token as a static bearer, and the
 * agent checks it against MULLION_AGENT_TOKEN.
 */
export function staticEnvUpdateSnippet(token: string): string {
  return `MULLION_AGENT_TOKEN=${token}`;
}
