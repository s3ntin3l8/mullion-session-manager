import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { useDashboardStore } from "../../store/index.js";
import { ApiError } from "../../api/index.js";
import type { DeviceHostEntry, DiscoveredDevice, PairAndConnectBody } from "../../api/index.js";
import { LOCAL_HOST_ID } from "../../../../src/shared/constants.js";
import { usePolling } from "../../hooks/usePolling.js";
import { useBlurWhenLeaving, useDismissExit, useParentPresence } from "../../hooks/usePresence.js";
import { CloseIcon, DeviceIcon } from "../../ui/icons.js";
import { Dropdown, SecondaryButton } from "../../ui/primitives.js";
import { ErrorText } from "../../ui/ErrorText.js";

// A UI-side cadence only: the backend's discovery cache is updated by mDNS
// events as they arrive (src/services/device-discovery.ts), so this just
// bounds how long a newly advertised phone takes to show up in the list.
export const DISCOVERY_POLL_MS = 2500;
// How long the "Looking for nearby devices…" state lasts before the manual
// form opens on its own (issue #1379). Scanning keeps going after this, so a
// phone that shows up late still appears above the manual form.
export const DISCOVERY_TIMEOUT_MS = 3000;

// Same rule as routes/devices.ts's isValidPairingCode — checked here so
// "Pair & Connect" stays disabled instead of round-tripping a 400.
const PAIRING_CODE_PATTERN = /^\d{6}$/;

function describeDiscovered(entry: DiscoveredDevice): string {
  const label = entry.name || entry.model || entry.host;
  return label === entry.host ? entry.host : `${label} · ${entry.host}`;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="create-modal-field">
      <span className="create-modal-field-label">{label}</span>
      <span className="create-modal-input-row">{children}</span>
      {hint && <span className="create-modal-field-hint">{hint}</span>}
    </label>
  );
}

// Settings -> Devices -> "Pair a phone or tablet" (issue #1379) — the UI for
// issue #1378's mDNS discovery + atomic pair-and-connect endpoint. Modeled
// on PairBridgeModal.tsx (same create-modal shell, same usePolling-driven
// wait). Replaces DevicesSection's old two-form Pair-then-Connect flow: the
// user picks a discovered phone (or types its addresses by hand behind
// "Pair manually"), enters the 6-digit code, and one POST does the rest.
export function PairDeviceDialog({
  onClose,
  onPaired,
  deviceHosts = null,
}: {
  onClose: () => void;
  onPaired: () => void;
  // The hosts that can run devices (DevicesSection's `GET /api/devices/hosts`
  // read); a host picker appears when more than one can pair a phone.
  deviceHosts?: DeviceHostEntry[] | null;
}) {
  const listDiscovered = useDashboardStore((s) => s.listDiscovered);
  const pairAndConnect = useDashboardStore((s) => s.pairAndConnect);

  const [chosenHostId, setHostId] = useState(LOCAL_HOST_ID);
  const [hostPicked, setHostPicked] = useState(false);
  // Set when listing an agent's phones fails (503 unreachable, 400 unknown or
  // outdated agent) — shown instead of the "No devices found" hint.
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredDevice[]>([]);
  const [scanTimedOut, setScanTimedOut] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // `null` = nothing decided yet (manual form closed, lone-phone auto-pick
  // active); a boolean = the form's latched state, set either by the user's
  // own toggle or by the scan timing out empty-handed. Latched so a phone
  // that shows up later lands in the list without yanking an auto-opened
  // form shut mid-typing — the user picks it (or hides the form) themselves.
  const [manualChoice, setManualChoice] = useState<boolean | null>(null);
  // Read by the timeout below, which fires once from a mount-time closure.
  const pairableCountRef = useRef(0);

  const [pairingCode, setPairingCode] = useState("");
  const [name, setName] = useState("");
  const [pairingAddress, setPairingAddress] = useState("");
  const [connectAddress, setConnectAddress] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const id = setTimeout(() => {
      setScanTimedOut(true);
      if (pairableCountRef.current === 0) setManualChoice((prev) => prev ?? true);
    }, DISCOVERY_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, []);

  // Every host stays listed so the picker is honest about the primary; one
  // that can't pair a phone is shown disabled.
  const hostOptions = (deviceHosts ?? []).map((h) => ({
    value: h.hostId,
    label:
      h.status === "unsupported"
        ? `${h.name} — unsupported (agent needs an update)`
        : h.status === "unreachable"
          ? `${h.name} — unreachable`
          : !h.deviceKinds.includes("physical")
            ? `${h.name} — cannot pair devices`
            : h.name,
    disabled: h.status !== "ok" || !h.deviceKinds.includes("physical"),
  }));
  // Until the user picks one, the first host that can pair (the primary may
  // have no adb of its own while an agent has). An explicit pick is kept even
  // if that host later turns unreachable: the scan then says so, instead of
  // pairing silently moving elsewhere.
  const hostId = hostPicked
    ? chosenHostId
    : (hostOptions.find((o) => !o.disabled)?.value ?? chosenHostId);

  usePolling(
    (isCancelled) => {
      listDiscovered(hostId)
        .then((list) => {
          if (isCancelled()) return;
          setDiscoverError(null);
          setDiscovered(list);
          const pairableIds = list
            .filter((entry) => entry.pairingAddress !== undefined)
            .map((entry) => entry.id);
          pairableCountRef.current = pairableIds.length;
          if (manualChoice === true) return;
          // The auto-pick for a lone pairable phone is stored as a real
          // selection (not derived per render), so a second phone showing up
          // on a later tick doesn't yank the code/name fields away mid-typing.
          // A selection whose phone dropped off the scan (screen closed, out
          // of range) is replaced by the lone remaining pairable phone if
          // there is exactly one, else cleared — never submitted stale.
          const kept = selectedId !== null && pairableIds.includes(selectedId);
          const next = kept ? selectedId : pairableIds.length === 1 ? pairableIds[0] : null;
          if (next !== selectedId) {
            setSelectedId(next);
            // A device address typed for the previous phone must not ride
            // along as an override for a different one (Hermes review).
            setConnectAddress("");
          }
        })
        // The primary's endpoint never errors (disabled discovery is `[]`); an
        // agent's can (503/400), and the backend's message says why. Any other
        // failure (a network blip) keeps the previous snapshot until the next tick.
        .catch((err: unknown) => {
          if (isCancelled()) return;
          if (err instanceof ApiError && (err.statusCode === 503 || err.statusCode === 400)) {
            setDiscovered([]);
            pairableCountRef.current = 0;
            setDiscoverError(err.message);
          }
        });
    },
    DISCOVERY_POLL_MS,
    { enabled: !submitting, deps: [hostId] },
  );

  const showHostPicker = hostOptions.length > 1;

  const changeHost = (next: string) => {
    setHostPicked(true);
    if (next === hostId) return;
    setHostId(next);
    // Nothing scanned on the old host applies to the new one.
    setDiscovered([]);
    setDiscoverError(null);
    pairableCountRef.current = 0;
    setSelectedId(null);
    setConnectAddress("");
    setPairingAddress("");
    setError(null);
  };

  // Android only advertises the pairing service while its "Pair device with
  // pairing code" screen is open, and pair-and-connect can't pair without
  // it — a connect-only entry is an already-paired phone (reconnecting
  // those is issue #1380's job), so it's listed but not selectable.
  const pairable = discovered.filter((entry) => entry.pairingAddress !== undefined);
  const manualOpen = manualChoice ?? false;
  const selected = pairable.find((entry) => entry.id === selectedId);
  const mode: "discovery" | "manual" | null = manualOpen ? "manual" : selected ? "discovery" : null;

  const codeValid = PAIRING_CODE_PATTERN.test(pairingCode);
  const canSubmit =
    !submitting &&
    codeValid &&
    ((mode === "discovery" &&
      (selected?.connectAddress !== undefined || connectAddress.trim() !== "")) ||
      (mode === "manual" && pairingAddress.trim() !== "" && connectAddress.trim() !== ""));

  const select = (entry: DiscoveredDevice) => {
    setSelectedId(entry.id);
    setManualChoice(false);
    setConnectAddress("");
    setError(null);
  };

  const toggleManual = () => {
    const next = !manualOpen;
    setManualChoice(next);
    // Closing the manual form re-applies the lone-phone auto-pick right
    // away instead of waiting for the next scan tick to do it.
    setSelectedId(next ? null : pairable.length === 1 ? pairable[0].id : null);
    setConnectAddress("");
    setError(null);
  };

  const submit = () => {
    if (!canSubmit) return;
    const trimmedName = name.trim() || undefined;
    const trimmedConnect = connectAddress.trim();
    const hostField = hostId === LOCAL_HOST_ID ? {} : { hostId };
    const body: PairAndConnectBody =
      mode === "discovery" && selected
        ? {
            discoveryId: selected.id,
            pairingCode,
            name: trimmedName,
            // Only an entry that never advertised its connect port shows the
            // override field, so only it may send one.
            ...(selected.connectAddress === undefined && trimmedConnect
              ? { connectAddress: trimmedConnect }
              : {}),
            ...hostField,
          }
        : {
            pairingAddress: pairingAddress.trim(),
            connectAddress: trimmedConnect,
            pairingCode,
            name: trimmedName,
            ...hostField,
          };
    setError(null);
    setSubmitting(true);
    pairAndConnect(body)
      .then(() => onPaired())
      .catch((err: unknown) => {
        // Rendered verbatim — the backend's own messages already say what to
        // do next (wrong code, "re-open the picker", 409 already active).
        setError(err instanceof ApiError ? err.message : "Could not pair this device");
      })
      .finally(() => setSubmitting(false));
  };

  const onEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter") submit();
  };

  // #3453 — mounted inside a `<Presence>` the parent decides, as ui/Modal's
  // DialogModal does: a successful pairing (`onPaired`) closes it at once and
  // the Presence plays the one exit, during which the dialog is `inert`.
  // Bare (no Presence), its own dismiss controls play the exit (#3015) before
  // `onClose`. This dialog builds the create-modal markup itself and has no
  // focus trap to deactivate.
  const backdropRef = useRef<HTMLDivElement>(null);
  const parent = useParentPresence(backdropRef);
  const parentLeaving = parent?.leaving ?? false;
  const { state: ownPresence, dismiss: dismissWithExit } = useDismissExit(onClose, backdropRef);
  const presence = parentLeaving ? "leaving" : ownPresence;
  const dismiss = parent ? onClose : dismissWithExit;
  useBlurWhenLeaving(parentLeaving, backdropRef);

  return (
    <div
      ref={backdropRef}
      className="create-modal-backdrop motion-scrim"
      data-presence={presence}
      inert={parentLeaving || undefined}
      onClick={dismiss}
    >
      <div
        className="create-modal motion-dialog"
        role="dialog"
        aria-label="Pair a phone or tablet"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="create-modal-header">
          <span className="create-modal-icon">
            <DeviceIcon size={16} />
          </span>
          <span className="create-modal-header-text">
            <span className="create-modal-title">Pair a phone or tablet</span>
            <span className="create-modal-subtitle">
              On the phone: Developer options → Wireless debugging → Pair device with pairing code.
            </span>
          </span>
          <button className="create-modal-close" aria-label="Close" onClick={dismiss}>
            <CloseIcon size={15} />
          </button>
        </div>

        <div className="create-modal-body">
          {showHostPicker && (
            <div className="create-modal-field">
              <span className="create-modal-field-label">Host</span>
              <Dropdown
                ariaLabel="Host"
                options={hostOptions}
                value={hostId}
                onChange={changeHost}
                disabled={submitting}
              />
              <span className="create-modal-field-hint">
                The machine whose adb server pairs the phone — it must be on the phone's network.
              </span>
            </div>
          )}
          <div className="create-modal-field">
            <span className="create-modal-field-label">Nearby devices</span>
            {discoverError !== null && <ErrorText>{discoverError}</ErrorText>}
            {discovered.length === 0 && discoverError === null && !scanTimedOut && (
              <div className="settings-readonly-value">Looking for nearby devices…</div>
            )}
            {discovered.length === 0 && discoverError === null && scanTimedOut && (
              <span className="create-modal-field-hint">
                No devices found yet — still looking. Make sure the phone is on the same network, or
                pair manually below.
              </span>
            )}
            {discovered.length > 0 && (
              <div role="radiogroup" aria-label="Nearby devices" className="settings-list">
                {discovered.map((entry) => {
                  const canPair = entry.pairingAddress !== undefined;
                  return (
                    <label
                      key={entry.id}
                      className={`settings-list-row${canPair ? "" : " unavailable"}`}
                      style={{ cursor: canPair ? "pointer" : "default" }}
                    >
                      <input
                        type="radio"
                        name="discovered-device"
                        checked={mode === "discovery" && selected?.id === entry.id}
                        disabled={!canPair || submitting}
                        onChange={() => select(entry)}
                      />
                      <span className="settings-list-row-title">{describeDiscovered(entry)}</span>
                      {!canPair && (
                        <span className="settings-list-row-subtitle">
                          Open “Pair device with pairing code” on the phone
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <SecondaryButton onClick={toggleManual} disabled={submitting}>
              {manualOpen ? "Hide manual pairing" : "Pair manually"}
            </SecondaryButton>
          </div>

          {mode === "manual" && (
            <>
              <Field
                label="Pairing address"
                hint="From the Pair device with pairing code dialog — host:port."
              >
                <input
                  className="mono"
                  placeholder="192.168.1.23:41234"
                  value={pairingAddress}
                  onChange={(e) => setPairingAddress(e.target.value)}
                  onKeyDown={onEnter}
                />
              </Field>
              <Field
                label="Device address"
                hint="A DIFFERENT port than pairing — shown at the top of the Wireless debugging screen."
              >
                <input
                  className="mono"
                  placeholder="192.168.1.23:37251"
                  value={connectAddress}
                  onChange={(e) => setConnectAddress(e.target.value)}
                  onKeyDown={onEnter}
                />
              </Field>
            </>
          )}

          {mode === "discovery" && selected && selected.connectAddress === undefined && (
            <Field
              label="Device address"
              hint="This phone hasn't advertised its connect port — enter the host:port shown at the top of its Wireless debugging screen."
            >
              <input
                className="mono"
                placeholder="192.168.1.23:37251"
                value={connectAddress}
                onChange={(e) => setConnectAddress(e.target.value)}
                onKeyDown={onEnter}
              />
            </Field>
          )}

          {mode !== null && (
            <>
              <Field label="Pairing code" hint="The 6-digit code shown on the phone.">
                <input
                  className="mono"
                  placeholder="123456"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={pairingCode}
                  onChange={(e) => setPairingCode(e.target.value.replace(/\D/g, ""))}
                  onKeyDown={onEnter}
                />
              </Field>
              <Field label="Name" hint="Optional — falls back to the device address.">
                <input
                  placeholder="My Pixel"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={onEnter}
                />
              </Field>
            </>
          )}

          {error && <ErrorText>{error}</ErrorText>}
        </div>

        <div className="create-modal-footer">
          <span className="create-modal-footer-hint">
            {mode === null
              ? "Pick a device above, or pair manually."
              : "Pairs and connects in one step."}
          </span>
          <button className="create-modal-cancel" onClick={dismiss}>
            Cancel
          </button>
          <button className="create-modal-submit" onClick={submit} disabled={!canSubmit}>
            {submitting ? "Pairing…" : "Pair & Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}
