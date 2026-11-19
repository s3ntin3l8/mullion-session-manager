import type { FastifyInstance } from "fastify";
import {
  AvdCreatedError,
  avdConfigRoots,
  createAvd,
  licensesMayBePending,
  listAvailableSystemImages,
  listAvds,
  listDeviceProfiles,
  listInstalledSystemImages,
  normalizeAvdHardware,
  type AvailableSystemImage,
  type CreateAvdInput,
  type CreateAvdResult,
  type SystemImage,
} from "./avd-manager.js";
export type { CreateAvdInput, CreateAvdResult };
import { LOCAL_HOST_ID } from "./host-registry.js";
import { getRemoteHostClient } from "./remote-host-client.js";

// AVD name, as accepted by `avdmanager create avd -n`. Deliberately an
// allowlist matching avdmanager's own accepted charset (alphanumerics,
// dots, underscores, hyphens), not a "reject metacharacters" denylist.
//
// CodeQL (js/polynomial-redos) — an earlier version of this combined the
// charset check and the "at least one alphanumeric" (Hermes review, keeps a
// bare "." or ".." from passing) into a SINGLE regex with two overlapping
// `[A-Za-z0-9._-]*` groups around a middle character — classic catastrophic
// backtracking on user-controlled input (e.g. many "0"s followed by one
// invalid character). Two independent, single-pass regexes below achieve
// the same validation with no ambiguity for the engine to backtrack over.
const AVD_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const AVD_NAME_HAS_ALPHANUMERIC = /[A-Za-z0-9]/;

export function isValidAvdName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    AVD_NAME_PATTERN.test(name) &&
    AVD_NAME_HAS_ALPHANUMERIC.test(name)
  );
}

/** Input validation error raised before calling an agent host (always 400). */
export class AvdValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AvdValidationError";
  }
}

export interface SdkHostState {
  availableImagesCache: Map<string, [number, AvailableSystemImage[]]>;
  sdkOperationInProgress: boolean;
}

const AVAILABLE_IMAGES_CACHE_TTL_MS = 5 * 60 * 1000;
const sdkHostStates = new WeakMap<FastifyInstance, SdkHostState>();

/** Per-Fastify-instance SDK state (5-min available-images cache + host-global operation lock). */
export function getSdkHostState(app: FastifyInstance): SdkHostState {
  let state = sdkHostStates.get(app);
  if (!state) {
    state = { availableImagesCache: new Map(), sdkOperationInProgress: false };
    sdkHostStates.set(app, state);
  }
  return state;
}

export interface AvdHost {
  readonly hostId: string;
  readonly isLocal: boolean;
  listAvds(): Promise<string[]>;
  listSystemImages(): Promise<SystemImage[]>;
  listAvailableSystemImages(): Promise<AvailableSystemImage[]>;
  listDeviceProfiles(): Promise<string[]>;
  createAvd(input: CreateAvdInput): Promise<CreateAvdResult>;
  sdkLicensesStatus(): Promise<{ pending: boolean }>;
}

/**
 * Runs AVD listing/creation against this process's own Android SDK.
 * Used both by `routes/avds.ts` (when `hostId` is local) and by
 * `routes/internal-avds.ts` (on an agent host).
 */
export class LocalAvdHost implements AvdHost {
  readonly hostId = LOCAL_HOST_ID;
  readonly isLocal = true;

  constructor(private readonly app: FastifyInstance) {}

  async listAvds(): Promise<string[]> {
    if (!this.app.deviceEmulatorEnabled) {
      throw new AvdValidationError(this.app.deviceEmulatorUnavailableMessage);
    }
    if (!this.app.config.DEVICE_AVDMANAGER_PATH) {
      throw new AvdValidationError("DEVICE_AVDMANAGER_PATH is not configured.");
    }
    return listAvds(this.app.config.DEVICE_AVDMANAGER_PATH);
  }

  async listSystemImages(): Promise<SystemImage[]> {
    if (!this.app.deviceEmulatorEnabled) {
      throw new AvdValidationError(this.app.deviceEmulatorUnavailableMessage);
    }
    if (!this.app.config.DEVICE_ANDROID_SDK_ROOT) {
      throw new AvdValidationError("DEVICE_ANDROID_SDK_ROOT is not configured.");
    }
    return listInstalledSystemImages(this.app.config.DEVICE_ANDROID_SDK_ROOT);
  }

  async listAvailableSystemImages(): Promise<AvailableSystemImage[]> {
    if (!this.app.deviceEmulatorEnabled) {
      throw new AvdValidationError(this.app.deviceEmulatorUnavailableMessage);
    }
    if (!this.app.config.DEVICE_SDKMANAGER_PATH) {
      throw new AvdValidationError("DEVICE_SDKMANAGER_PATH is not configured.");
    }
    if (!this.app.config.DEVICE_ANDROID_SDK_ROOT) {
      throw new AvdValidationError("DEVICE_ANDROID_SDK_ROOT is not configured.");
    }

    const { availableImagesCache } = getSdkHostState(this.app);
    const cacheKey = `${this.app.config.DEVICE_SDKMANAGER_PATH}:${this.app.config.DEVICE_ANDROID_SDK_ROOT}`;
    const cached = availableImagesCache.get(cacheKey);
    if (cached && Date.now() - cached[0] < AVAILABLE_IMAGES_CACHE_TTL_MS) {
      return cached[1];
    }

    const systemImages = await listAvailableSystemImages(
      this.app.config.DEVICE_SDKMANAGER_PATH,
      this.app.config.DEVICE_ANDROID_SDK_ROOT,
    );
    availableImagesCache.set(cacheKey, [Date.now(), systemImages]);
    return systemImages;
  }

  async sdkLicensesStatus(): Promise<{ pending: boolean }> {
    if (!this.app.deviceEmulatorEnabled) {
      throw new AvdValidationError(this.app.deviceEmulatorUnavailableMessage);
    }
    return { pending: licensesMayBePending() };
  }

  async listDeviceProfiles(): Promise<string[]> {
    if (!this.app.deviceEmulatorEnabled) {
      throw new AvdValidationError(this.app.deviceEmulatorUnavailableMessage);
    }
    if (!this.app.config.DEVICE_AVDMANAGER_PATH) {
      throw new AvdValidationError("DEVICE_AVDMANAGER_PATH is not configured.");
    }
    return listDeviceProfiles(this.app.config.DEVICE_AVDMANAGER_PATH);
  }

  async createAvd(input: CreateAvdInput): Promise<CreateAvdResult> {
    if (!this.app.deviceEmulatorEnabled) {
      throw new AvdValidationError(this.app.deviceEmulatorUnavailableMessage);
    }
    if (!this.app.config.DEVICE_AVDMANAGER_PATH) {
      throw new AvdValidationError("DEVICE_AVDMANAGER_PATH is not configured.");
    }
    if (!this.app.config.DEVICE_ANDROID_SDK_ROOT) {
      throw new AvdValidationError("DEVICE_ANDROID_SDK_ROOT is not configured.");
    }

    const { name, systemImage, deviceProfile } = input;
    if (!isValidAvdName(name)) {
      throw new AvdValidationError(
        "name is required and may only contain letters, digits, '.', '_', and '-'",
      );
    }

    // Allowlisted against the exact set this host's own SDK/avdmanager just
    // reported, not regex-validated — strictly stronger, and free (this
    // data is already being fetched to populate the frontend picker that
    // produced these values in the first place). Fetched in parallel: two
    // independent listings, not a data dependency between them.
    const [installedImages, deviceProfiles] = await Promise.all([
      listInstalledSystemImages(this.app.config.DEVICE_ANDROID_SDK_ROOT),
      listDeviceProfiles(this.app.config.DEVICE_AVDMANAGER_PATH),
    ]);
    if (!systemImage || !installedImages.some((img) => img.packagePath === systemImage)) {
      throw new AvdValidationError("systemImage must be one of the host's installed system images");
    }
    if (!deviceProfile || !deviceProfiles.includes(deviceProfile)) {
      throw new AvdValidationError("deviceProfile must be one of the host's known device profiles");
    }

    // Optional hardware. Empty/absent leaves avdmanager's own defaults.
    // Invalid sizes fail before createAvd so a bad SD-card string never
    // reaches the binary, and a bad RAM string never leaves a half-patched
    // AVD behind.
    const hardware = normalizeAvdHardware(input);
    if (!hardware.ok) throw new AvdValidationError(hardware.message);

    try {
      // Do not spread `hardware.value` into this object. CodeQL treats that
      // spread as tainting every property, including `avdmanagerPath`, which
      // is the execFile executable (js/command-line-injection). The three
      // size fields are copied by name so the path stays the config value.
      await createAvd({
        avdmanagerPath: this.app.config.DEVICE_AVDMANAGER_PATH,
        name,
        systemImage,
        deviceProfile,
        sdcardSize: hardware.value.sdcardSize,
        ramSizeMb: hardware.value.ramSizeMb,
        dataPartitionSize: hardware.value.dataPartitionSize,
        configRoots: avdConfigRoots(),
      });
    } catch (err) {
      if (err instanceof AvdCreatedError) {
        return { name, warning: err.message };
      }
      throw err;
    }

    return { name };
  }
}

class RemoteAvdHost implements AvdHost {
  readonly isLocal = false;

  constructor(
    private readonly app: FastifyInstance,
    readonly hostId: string,
  ) {}

  private get client() {
    return getRemoteHostClient(this.app, this.hostId);
  }

  listAvds(): Promise<string[]> {
    return this.client.avds.list();
  }

  listSystemImages(): Promise<SystemImage[]> {
    return this.client.avds.systemImages();
  }

  listAvailableSystemImages(): Promise<AvailableSystemImage[]> {
    return this.client.avds.availableSystemImages();
  }

  sdkLicensesStatus(): Promise<{ pending: boolean }> {
    return this.client.avds.sdkLicensesStatus();
  }

  listDeviceProfiles(): Promise<string[]> {
    return this.client.avds.deviceProfiles();
  }

  async createAvd(input: CreateAvdInput): Promise<CreateAvdResult> {
    if (!isValidAvdName(input.name)) {
      throw new AvdValidationError(
        "name is required and may only contain letters, digits, '.', '_', and '-'",
      );
    }
    if (!input.systemImage || typeof input.systemImage !== "string") {
      throw new AvdValidationError("systemImage is required");
    }
    if (!input.deviceProfile || typeof input.deviceProfile !== "string") {
      throw new AvdValidationError("deviceProfile is required");
    }
    const hardware = normalizeAvdHardware(input);
    if (!hardware.ok) throw new AvdValidationError(hardware.message);

    return this.client.avds.create({
      name: input.name,
      systemImage: input.systemImage,
      deviceProfile: input.deviceProfile,
      ...(input.sdcardSize !== undefined ? { sdcardSize: input.sdcardSize } : {}),
      ...(input.ramSize !== undefined ? { ramSize: input.ramSize } : {}),
      ...(input.dataPartitionSize !== undefined
        ? { dataPartitionSize: input.dataPartitionSize }
        : {}),
    });
  }
}

export function getAvdHost(app: FastifyInstance, hostId: string): AvdHost {
  return hostId === LOCAL_HOST_ID ? new LocalAvdHost(app) : new RemoteAvdHost(app, hostId);
}
