import type { FastifyInstance } from "fastify";
import {
  createAvd,
  listAvds,
  listDeviceProfiles,
  listInstalledSystemImages,
} from "../services/avd-manager.js";

// AVD (Android Virtual Device) provisioning — the counterpart to
// routes/devices.ts (which only RUNS an AVD that already exists on the
// host). Deliberately a separate route module (file-per-route-module
// convention, see routes/devices.ts's own header) since this is provisioning
// state on the host's SDK install, not a `devices` DB row — creating an AVD
// here doesn't create a `devices` row; the user still adds a device for it
// afterward via the existing `POST /api/devices {avdName}`.

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

interface CreateAvdBody {
  name?: string;
  systemImage?: string;
  deviceProfile?: string;
}

export async function avdsRoute(app: FastifyInstance): Promise<void> {
  app.get("/api/avds", async (_request, reply) => {
    if (!app.config.DEVICE_ENABLED) {
      return reply.badRequest("Device panel is disabled — set DEVICE_ENABLED=true.");
    }
    if (!app.config.DEVICE_AVDMANAGER_PATH) {
      return reply.badRequest("DEVICE_AVDMANAGER_PATH is not configured.");
    }
    // Self-review (mullion-reviewer) — an exec failure (a misconfigured
    // path, ENOENT, or the timeout path) used to fall through uncaught to a
    // generic 500, unlike every other misconfiguration case in this file,
    // which produces an actionable 400. Same fix applied to the sibling GET
    // handlers below and to the POST handler's own listDeviceProfiles call.
    try {
      const avds = await listAvds(app.config.DEVICE_AVDMANAGER_PATH);
      return { avds };
    } catch (err) {
      return reply.badRequest(err instanceof Error ? err.message : String(err));
    }
  });

  app.get("/api/system-images", async (_request, reply) => {
    if (!app.config.DEVICE_ENABLED) {
      return reply.badRequest("Device panel is disabled — set DEVICE_ENABLED=true.");
    }
    if (!app.config.DEVICE_ANDROID_SDK_ROOT) {
      return reply.badRequest("DEVICE_ANDROID_SDK_ROOT is not configured.");
    }
    // listInstalledSystemImages is pure fs (no exec) and never throws — see
    // its own safeReaddir() comment — so no try/catch is needed here.
    const systemImages = listInstalledSystemImages(app.config.DEVICE_ANDROID_SDK_ROOT);
    return { systemImages };
  });

  // Not in the original plan's own route list, but needed by it anyway:
  // `deviceProfile` validation (POST /api/avds below) allowlists against
  // this same listing rather than a free-text regex, and the "New AVD"
  // frontend form needs somewhere to source its device-profile picker from
  // — duplicating a second hardcoded list would drift from whatever
  // `avdmanager list device` actually reports on this host.
  app.get("/api/device-profiles", async (_request, reply) => {
    if (!app.config.DEVICE_ENABLED) {
      return reply.badRequest("Device panel is disabled — set DEVICE_ENABLED=true.");
    }
    if (!app.config.DEVICE_AVDMANAGER_PATH) {
      return reply.badRequest("DEVICE_AVDMANAGER_PATH is not configured.");
    }
    try {
      const deviceProfiles = await listDeviceProfiles(app.config.DEVICE_AVDMANAGER_PATH);
      return { deviceProfiles };
    } catch (err) {
      return reply.badRequest(err instanceof Error ? err.message : String(err));
    }
  });

  app.post<{ Body: CreateAvdBody }>("/api/avds", async (request, reply) => {
    if (!app.config.DEVICE_ENABLED) {
      return reply.badRequest("Device panel is disabled — set DEVICE_ENABLED=true.");
    }
    if (!app.config.DEVICE_AVDMANAGER_PATH) {
      return reply.badRequest("DEVICE_AVDMANAGER_PATH is not configured.");
    }
    if (!app.config.DEVICE_ANDROID_SDK_ROOT) {
      return reply.badRequest("DEVICE_ANDROID_SDK_ROOT is not configured.");
    }

    const { name, systemImage, deviceProfile } = request.body ?? {};
    if (!name || !AVD_NAME_PATTERN.test(name) || !AVD_NAME_HAS_ALPHANUMERIC.test(name)) {
      return reply.badRequest(
        "name is required and may only contain letters, digits, '.', '_', and '-'",
      );
    }

    // Allowlisted against the exact set this host's own SDK/avdmanager just
    // reported, not regex-validated — strictly stronger, and free (this
    // data is already being fetched to populate the frontend picker that
    // produced these values in the first place). Fetched in parallel: two
    // independent listings, not a data dependency between them.
    let installedImages;
    let deviceProfiles;
    try {
      [installedImages, deviceProfiles] = await Promise.all([
        listInstalledSystemImages(app.config.DEVICE_ANDROID_SDK_ROOT),
        listDeviceProfiles(app.config.DEVICE_AVDMANAGER_PATH),
      ]);
    } catch (err) {
      return reply.badRequest(err instanceof Error ? err.message : String(err));
    }
    if (!systemImage || !installedImages.some((img) => img.packagePath === systemImage)) {
      return reply.badRequest("systemImage must be one of the host's installed system images");
    }
    if (!deviceProfile || !deviceProfiles.includes(deviceProfile)) {
      return reply.badRequest("deviceProfile must be one of the host's known device profiles");
    }

    try {
      await createAvd({
        avdmanagerPath: app.config.DEVICE_AVDMANAGER_PATH,
        name,
        systemImage,
        deviceProfile,
      });
    } catch (err) {
      return reply.badRequest(err instanceof Error ? err.message : String(err));
    }

    reply.code(201);
    return { name };
  });
}
