import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { redeemPairingCode } from "./services/agent-pairing-redeem.js";
import { isLoopbackHostname } from "./services/browser-handoff.js";

export function parseArgs(argv: string[]): {
  primaryUrl: string;
  sessionsDir: string;
  name?: string;
  advertiseUrl?: string;
  hostname?: string;
  platform?: string;
  timeoutMs?: number;
} {
  let primaryUrl = "";
  let sessionsDir = "";
  let name: string | undefined;
  let advertiseUrl: string | undefined;
  let hostname: string | undefined;
  let platform: string | undefined;
  let timeoutMs: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--primary-url" && next !== undefined) {
      primaryUrl = next;
      i++;
    } else if (arg === "--sessions-dir" && next !== undefined) {
      sessionsDir = next;
      i++;
    } else if (arg === "--name" && next !== undefined) {
      name = next;
      i++;
    } else if (arg === "--advertise-url" && next !== undefined) {
      advertiseUrl = next;
      i++;
    } else if (arg === "--hostname" && next !== undefined) {
      hostname = next;
      i++;
    } else if (arg === "--platform" && next !== undefined) {
      platform = next;
      i++;
    } else if (arg === "--timeout" && next !== undefined) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--timeout must be a positive number of milliseconds");
      }
      timeoutMs = parsed;
      i++;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!primaryUrl.trim()) throw new Error("--primary-url is required");
  if (!sessionsDir.trim()) throw new Error("--sessions-dir is required");
  return { primaryUrl, sessionsDir, name, advertiseUrl, hostname, platform, timeoutMs };
}

export async function readFirstLineFromStdin(
  stdin: AsyncIterable<Buffer | string> = process.stdin,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  return firstLine.trim();
}

export async function main(
  argv: string[] = process.argv.slice(2),
  stdin: AsyncIterable<Buffer | string> = process.stdin,
  stdout: Pick<NodeJS.WritableStream, "write"> = process.stdout,
  stderr: Pick<NodeJS.WritableStream, "write"> = process.stderr,
): Promise<void> {
  const args = parseArgs(argv);
  const code = await readFirstLineFromStdin(stdin);
  if (!code) {
    throw new Error("Pairing code must be provided on stdin");
  }
  try {
    const parsedUrl = new URL(args.primaryUrl.trim());
    if (parsedUrl.protocol === "http:" && !isLoopbackHostname(parsedUrl.hostname)) {
      stderr.write(
        "WARNING: primary URL is plain http://; the pairing code and machine credential are sent unencrypted. Use https:// outside a trusted network.\n",
      );
    }
  } catch {
    // Let redeemPairingCode report the invalid URL error consistently.
  }
  const result = await redeemPairingCode({
    primaryUrl: args.primaryUrl,
    code,
    sessionsDir: args.sessionsDir,
    name: args.name,
    advertiseUrl: args.advertiseUrl,
    hostname: args.hostname,
    platform: args.platform,
    timeoutMs: args.timeoutMs,
  });
  stdout.write(`Paired host ${result.hostId}\n`);
}

function isDirectEntrypoint(): boolean {
  try {
    return (
      Boolean(process.argv[1]) &&
      fs.realpathSync(process.argv[1]!) === fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isDirectEntrypoint()) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
