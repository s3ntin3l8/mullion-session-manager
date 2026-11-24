import { redeemPairingCode } from "./services/agent-pairing-redeem.js";

function parseArgs(argv: string[]): {
  primaryUrl: string;
  sessionsDir: string;
  name?: string;
  advertiseUrl?: string;
} {
  let primaryUrl = "";
  let sessionsDir = "";
  let name: string | undefined;
  let advertiseUrl: string | undefined;

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
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!primaryUrl.trim()) throw new Error("--primary-url is required");
  if (!sessionsDir.trim()) throw new Error("--sessions-dir is required");
  return { primaryUrl, sessionsDir, name, advertiseUrl };
}

async function readFirstLineFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  return firstLine.trim();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const code = await readFirstLineFromStdin();
  if (!code) {
    throw new Error("Pairing code must be provided on stdin");
  }
  const result = await redeemPairingCode({
    primaryUrl: args.primaryUrl,
    code,
    sessionsDir: args.sessionsDir,
    name: args.name,
    advertiseUrl: args.advertiseUrl,
  });
  process.stdout.write(`Paired host ${result.hostId}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
