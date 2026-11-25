import { useMemo, useState } from "react";
import { api, ApiError } from "../../api/index.js";
import type { IosSimulator, SimulatorCatalog } from "../../api/index.js";
import { LOCAL_HOST_ID } from "../../../../src/shared/constants.js";
import { useAsyncData } from "../../hooks/useAsyncData.js";
import { Dropdown, Row, SecondaryButton, TextInput } from "../../ui/primitives.js";
import { CustomSelect } from "../../ui/CustomSelect.js";
import { sortDeviceTypes, sortRuntimes } from "./simulatorList.js";
import { ErrorText } from "../../ui/ErrorText.js";

// Mirrors the server's SIMULATOR_NAME_PATTERN (src/services/ios-simulators.ts):
// checked here so a bad name fails fast; the server's check stays authoritative.
const SIMULATOR_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._()'-]*$/u;
const MAX_NAME_LENGTH = 64;

function describeSimulatorNameError(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_NAME_LENGTH) return `At most ${MAX_NAME_LENGTH} characters.`;
  if (!SIMULATOR_NAME_PATTERN.test(trimmed)) {
    return "Letters, digits, spaces and . _ ( ) ' - only, starting with a letter or digit.";
  }
  return null;
}

/**
 * "+ New simulator" for the iOS branch of the create-device form: picks a
 * device type and runtime from the target host's own catalog and creates the
 * simulator with `simctl create`, the way "+ New AVD" does for Android. It only
 * creates; the new simulator is handed back so the parent can preselect it.
 */
export function NewSimulatorForm({
  hostId,
  onCreated,
}: {
  hostId: string;
  onCreated: (simulator: IosSimulator) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [catalog, setCatalog] = useState<SimulatorCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [deviceTypeId, setDeviceTypeId] = useState("");
  const [runtimeId, setRuntimeId] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useAsyncData(
    () => api.listSimulatorCatalog(hostId),
    (value) => {
      setCatalog(value);
      setCatalogError(null);
    },
    (err: unknown) => {
      setCatalogError(
        err instanceof ApiError ? err.message : "Could not load device types and runtimes",
      );
    },
    [hostId, open],
    {
      enabled: open,
      onStart: () => {
        setCatalog(null);
        setCatalogError(null);
        setDeviceTypeId("");
        setRuntimeId("");
      },
    },
  );

  // Newest first, and the newest preselected (the newest iPhone, the newest iOS).
  const deviceTypes = useMemo(() => sortDeviceTypes(catalog?.deviceTypes ?? []), [catalog]);
  const runtimes = useMemo(() => sortRuntimes(catalog?.runtimes ?? []), [catalog]);
  const selectedType = deviceTypes.some((t) => t.id === deviceTypeId)
    ? deviceTypeId
    : (deviceTypes[0]?.id ?? "");
  const selectedRuntime = runtimes.some((r) => r.id === runtimeId)
    ? runtimeId
    : (runtimes[0]?.id ?? "");
  // An empty name falls back to "<device type> (<runtime>)", as Xcode names one;
  // the placeholder shows exactly that, and nothing (not a fixed example) until
  // the catalog has loaded.
  const typeName = deviceTypes.find((t) => t.id === selectedType)?.name;
  const runtimeName = runtimes.find((r) => r.id === selectedRuntime)?.name;
  const defaultName = typeName && runtimeName ? `${typeName} (${runtimeName})` : "";
  const trimmed = name.trim() || defaultName;
  // The name that will be sent, so a too-long or odd default is caught too.
  const nameError = describeSimulatorNameError(trimmed);
  const canCreate =
    !creating && trimmed.length > 0 && nameError === null && selectedType && selectedRuntime;

  const submit = () => {
    if (!canCreate) return;
    setError(null);
    setCreating(true);
    api
      .createSimulator({
        name: trimmed,
        deviceTypeId: selectedType,
        runtimeId: selectedRuntime,
        ...(hostId === LOCAL_HOST_ID ? {} : { hostId }),
      })
      .then((simulator) => {
        setName("");
        setOpen(false);
        onCreated(simulator);
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Could not create the simulator");
      })
      .finally(() => setCreating(false));
  };

  return (
    <>
      <div style={{ marginTop: 8 }}>
        <SecondaryButton onClick={() => setOpen((v) => !v)}>
          {open ? "Cancel new simulator" : "+ New simulator"}
        </SecondaryButton>
      </div>
      {open && (
        <div style={{ marginTop: 10 }}>
          <Row
            label="New simulator name"
            desc="Optional. Defaults to the device type and runtime. Letters, digits, spaces and . _ ( ) ' - only."
          >
            <TextInput
              style={{ width: 220 }}
              aria-label="New simulator name"
              placeholder={defaultName}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              aria-invalid={nameError !== null}
            />
          </Row>
          {nameError !== null && <ErrorText style={{ marginTop: 4 }}>{nameError}</ErrorText>}
          {!catalog && !catalogError && (
            <div className="settings-readonly-value" style={{ marginTop: 4 }}>
              Loading device types and runtimes…
            </div>
          )}
          {catalogError && <ErrorText style={{ marginTop: 8 }}>{catalogError}</ErrorText>}
          {deviceTypes.length > 0 && (
            <Row label="Device type" desc="The iPhone or iPad model to simulate, newest first.">
              <CustomSelect
                label="Device type"
                searchable
                emptyMessage="No matching device types"
                options={deviceTypes.map((t) => ({ value: t.id, label: t.name }))}
                value={selectedType}
                onChange={setDeviceTypeId}
              />
            </Row>
          )}
          {catalog && catalog.deviceTypes.length === 0 && (
            <div style={{ fontSize: "0.71875rem", color: "var(--dim)", marginTop: 4 }}>
              No iPhone or iPad device types are available on this machine. Check the Xcode
              installation.
            </div>
          )}
          {runtimes.length > 0 && (
            <Row label="Runtime" desc="An installed iOS version, newest first.">
              <Dropdown
                options={runtimes.map((r) => ({ value: r.id, label: r.name }))}
                value={selectedRuntime}
                onChange={setRuntimeId}
              />
            </Row>
          )}
          {catalog && catalog.runtimes.length === 0 && (
            <div style={{ fontSize: "0.71875rem", color: "var(--dim)", marginTop: 4 }}>
              No iOS runtimes installed. Install one in Xcode → Settings → Components.
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            <SecondaryButton onClick={submit} disabled={!canCreate}>
              {creating ? "Creating simulator…" : "Create simulator"}
            </SecondaryButton>
          </div>
          {error && <ErrorText style={{ marginTop: 8 }}>{error}</ErrorText>}
        </div>
      )}
    </>
  );
}
