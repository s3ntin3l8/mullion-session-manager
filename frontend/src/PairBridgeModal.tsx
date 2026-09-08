import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api/index.js";
import type { BridgePairingResponse } from "./api/index.js";
import { CloseIcon, HostsIcon } from "./ui/icons.js";
import { usePolling } from "./hooks/usePolling.js";
import { SecondaryButton, Segmented } from "./ui/primitives.js";
import { ErrorText } from "./ui/ErrorText.js";

const POLL_INTERVAL_MS = 2000;

type HelperPlatform = "windows" | "macos" | "linux";

// Best-effort default only, always user-overridable below (via the
// Segmented control) — the browser viewing Settings is frequently NOT the
// laptop being paired (this app is routinely driven from a phone), so
// guessing wrong here must never block or mislabel anything, only pick
// which of three equally-correct command forms starts selected.
function detectPlatform(): HelperPlatform {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macos";
  return "linux";
}

// Three real, different invocations — not one command with a platform
// swapped in. Sources: docs/ssh-agent.md's own Pairing section (Linux/
// tarball form, and the macOS `.pkg` form where the binary is
// `mullion-helper` and the verb doubles) and deploy/windows/
// mullion-helper.iss (the Windows form: no `mullion` on PATH, and a
// leading quoted path is inert in PowerShell — Windows 11's default
// terminal — without the `&` call operator prefix). Shared by commandFor
// (helper pair) and runCommandFor (helper run) below so the three
// per-platform invocation strings only exist once.
function programFor(platform: HelperPlatform): string {
  switch (platform) {
    case "windows":
      return '& "$env:LOCALAPPDATA\\Mullion\\mullion-helper.exe"';
    case "macos":
      return "mullion-helper";
    case "linux":
      return "mullion";
  }
}

function commandFor(platform: HelperPlatform, payload: string): string {
  const arg = platform === "linux" ? `'${payload}'` : payload;
  return `${programFor(platform)} helper pair ${arg}`;
}

// Shown once `hasLiveSession` flips true (see the `mine` polling result
// below) — `helper pair` only redeems the code and persists a credential,
// it never opens the forwarding connection itself; `helper run` is the
// separate step that actually starts forwarding.
function runCommandFor(platform: HelperPlatform): string {
  return `${programFor(platform)} helper run`;
}

const PLATFORM_OPTIONS: Array<{ value: HelperPlatform; label: string }> = [
  { value: "windows", label: "Windows" },
  { value: "macos", label: "macOS" },
  { value: "linux", label: "Linux" },
];

// Shared by both the "not yet paired" and "paired, now run it" bodies below
// — same platform picker + command box + copy button, just a different
// command string and copied-flag source.
function PlatformCommandPicker({
  platform,
  onPlatformChange,
  command,
  copied,
  onCopy,
}: {
  platform: HelperPlatform;
  onPlatformChange: (platform: HelperPlatform) => void;
  command: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <>
      <div style={{ marginTop: 14 }}>
        <Segmented options={PLATFORM_OPTIONS} value={platform} onChange={onPlatformChange} />
      </div>
      <div className="bridge-pairing-command" style={{ marginTop: 8 }}>
        {command}
      </div>
      <div style={{ marginTop: 10 }}>
        <SecondaryButton onClick={onCopy}>{copied ? "Copied" : "Copy command"}</SecondaryButton>
      </div>
    </>
  );
}

// Issue #820 PR7c — same create-modal-* shell and "starts the flow the
// moment this mounts, polls until the other side finishes" shape as
// GitHubDeviceFlowModal.tsx, adapted for a one-paste CLI credential instead
// of a short user-facing code: `mullion helper pair <payload>` runs on the
// laptop out of band (there's no verification_uri for this app to open —
// see agent-bridge.ts's own comment on why the payload bundles the
// server's base URL), so this modal's only job is showing the payload to
// copy and then noticing, via polling GET /api/bridges, once that bridge id
// shows up connected.
export function PairBridgeModal({
  onClose,
  onPaired,
}: {
  onClose: () => void;
  onPaired: () => void;
}) {
  const [pairing, setPairing] = useState<BridgePairingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Separate "Copied" flags for the two buttons — a single shared `copied`
  // flag would flip BOTH labels to "Copied" whichever one was actually
  // clicked, since they render from the same boolean.
  const [payloadCopied, setPayloadCopied] = useState(false);
  const [commandCopied, setCommandCopied] = useState(false);
  const [connected, setConnected] = useState(false);
  // True as soon as `helper pair` redeems the code (BridgeSummary's own
  // `hasLiveSession`) — independent of `connected`, which only flips once
  // `helper run`/`helper install` actually opens the forwarding connection.
  // Without this, "haven't run `helper pair` yet" and "paired, now waiting
  // on `helper run`" rendered identically (both just "Waiting for the
  // helper to connect…"), with no sign the pair step had actually landed.
  const [paired, setPaired] = useState(false);
  const [platform, setPlatform] = useState<HelperPlatform>(detectPlatform);
  // Reflects the TTL the server actually issued (bridge-registry.ts's
  // PAIRING_CODE_TTL_MS, currently 10 minutes) rather than a hardcoded
  // literal that would silently lie if that constant ever moved — computed
  // once, when `pairing` arrives (in the fetch effect below, not here: a
  // render-phase `Date.now()` read is an impure call React's own purity
  // rule forbids), not re-derived on a live countdown timer, since a modal
  // open for the code's full 10-minute life is the edge case, not the
  // common path.
  const [expiresInMinutes, setExpiresInMinutes] = useState<number | null>(null);

  // Same stable-ref reasoning as GitHubDeviceFlowModal.tsx's own
  // onConnectedRef — keeps the polling effect's deps at a fixed shape so a
  // fresh inline `onPaired` closure each render doesn't tear down and
  // recreate the interval.
  const onPairedRef = useRef(onPaired);
  useEffect(() => {
    onPairedRef.current = onPaired;
  });

  useEffect(() => {
    api
      .pairBridge()
      .then((response) => {
        setPairing(response);
        const ms = new Date(response.expires_at).getTime() - Date.now();
        setExpiresInMinutes(Math.max(1, Math.round(ms / 60000)));
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Could not generate a pairing code");
      });
  }, []);

  // Stops polling the moment this bridge id shows connected — `enabled`
  // recomputes to `false` on that transition, same "tear down via
  // usePolling's own effect cleanup, no extra state needed" shape as
  // GitHubDeviceFlowModal.tsx's `state.status !== "pending"` gate.
  usePolling(
    () => {
      if (!pairing) return;
      api
        .listBridges()
        .then((bridges) => {
          const mine = bridges.find((b) => b.id === pairing.bridge_id);
          if (mine?.hasLiveSession) setPaired(true);
          if (mine?.connected) {
            setConnected(true);
            onPairedRef.current();
          }
        })
        .catch(() => {
          // A transient poll failure just keeps waiting — the pairing
          // payload itself doesn't expire for another several minutes (see
          // the footer hint below), so one missed beat isn't worth
          // surfacing as an error.
        });
    },
    POLL_INTERVAL_MS,
    { enabled: pairing !== null && !connected, immediate: false },
  );

  const copyPayload = () => {
    if (!pairing) return;
    void navigator.clipboard
      ?.writeText(pairing.pairing_payload)
      .then(() => {
        setPayloadCopied(true);
        setTimeout(() => setPayloadCopied(false), 2000);
      })
      .catch(() => {});
  };

  const copyCommand = () => {
    if (!pairing) return;
    const command = paired
      ? runCommandFor(platform)
      : commandFor(platform, pairing.pairing_payload);
    void navigator.clipboard
      ?.writeText(command)
      .then(() => {
        setCommandCopied(true);
        setTimeout(() => setCommandCopied(false), 2000);
      })
      .catch(() => {});
  };

  return (
    <div className="create-modal-backdrop" onClick={onClose}>
      <div className="create-modal" onClick={(e) => e.stopPropagation()}>
        <div className="create-modal-header">
          <span className="create-modal-icon">
            <HostsIcon size={16} />
          </span>
          <span className="create-modal-header-text">
            <span className="create-modal-title">Pair an SSH agent bridge</span>
            <span className="create-modal-subtitle">
              Run this on your laptop to forward its SSH agent to every enrolled host.
            </span>
          </span>
          <button className="create-modal-close" onClick={onClose}>
            <CloseIcon size={15} />
          </button>
        </div>

        <div className="create-modal-body">
          {error && <ErrorText>{error}</ErrorText>}
          {!error && !pairing && (
            <div className="settings-readonly-value">Generating a pairing code…</div>
          )}
          {!error && pairing && !connected && !paired && (
            <>
              <div className="bridge-pairing-command">{pairing.pairing_payload}</div>
              <div style={{ marginTop: 10 }}>
                <SecondaryButton onClick={copyPayload}>
                  {payloadCopied ? "Copied" : "Copy payload"}
                </SecondaryButton>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 8 }}>
                Paste this into the Windows or macOS installer's "Pairing payload" field. Running
                the CLI by hand instead? The command differs by platform:
              </div>

              <PlatformCommandPicker
                platform={platform}
                onPlatformChange={setPlatform}
                command={commandFor(platform, pairing.pairing_payload)}
                copied={commandCopied}
                onCopy={copyCommand}
              />

              <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 12 }}>
                Waiting for the helper to connect…
              </div>
            </>
          )}
          {!error && pairing && !connected && paired && (
            <>
              <div style={{ fontSize: 12.5, color: "var(--g)" }}>
                Paired — the credential is saved. Now start the forwarder on your laptop:
              </div>

              <PlatformCommandPicker
                platform={platform}
                onPlatformChange={setPlatform}
                command={runCommandFor(platform)}
                copied={commandCopied}
                onCopy={copyCommand}
              />

              <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 12 }}>
                Or run <code>helper install</code> instead of <code>helper run</code> to keep it
                running across reboots. Waiting for it to connect…
              </div>
            </>
          )}
          {!error && connected && (
            <div style={{ fontSize: 12.5, color: "var(--g)" }}>
              Connected — this bridge is ready to forward SSH-agent requests.
            </div>
          )}
        </div>

        <div className="create-modal-footer">
          <span className="create-modal-footer-hint">
            {pairing && !connected && !paired
              ? `The pairing code expires in about ${expiresInMinutes} minute${expiresInMinutes === 1 ? "" : "s"} if left unused.`
              : "You can close this at any time."}
          </span>
          <button className="create-modal-cancel" onClick={onClose}>
            {connected ? "Done" : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}
