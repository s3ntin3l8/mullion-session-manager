// @vitest-environment jsdom
// Issue #2411 — the five lazy loads this section used to hand-roll (each
// its own `let cancelled = false` effect) now go through the shared
// useAsyncData hook. This file is the coverage that came with the
// migration: the loading, empty, failed and in-flight state of the three
// loads a user reaches on their own — the AVD picker, the New-AVD
// provisioning data and the available-images list — plus the guarantee the
// hook has to keep: a superseded load must not apply its result.
//
// The two install-driven refreshes keep the coverage they already had in
// Settings.devices.test.tsx, which this change leaves untouched.
//
// It renders DevicesSection directly rather than the whole Settings modal.
// Settings.devices.test.tsx stays untouched and keeps covering the section
// through the modal.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DevicesSection } from "./DevicesSection.js";
import { SERVER_INFO_FIXTURE } from "../../test/serverInfoFixture.js";
import { jsonResponse } from "../../test/jsonResponse.js";
import { mockFetch } from "../../test/mockFetch.js";
import { resetStore } from "../../test/resetStore.js";

type Handler = () => Response | Promise<Response>;

const SYSTEM_IMAGE = {
  packagePath: "system-images;android-35;google_apis;x86_64",
  apiLevel: "35",
  tagDisplay: "Google APIs",
  abi: "x86_64",
};

const AVAILABLE_IMAGE = {
  packagePath: "system-images;android-35;google_apis;x86_64",
  apiLevel: "35",
  tag: "google_apis",
  tagDisplay: "Google APIs",
  abi: "x86_64",
  installed: true,
};

const DEFAULTS = {
  avds: (): Response => jsonResponse(200, { avds: ["pixel_7"] }),
  systemImages: (): Response => jsonResponse(200, { systemImages: [SYSTEM_IMAGE] }),
  deviceProfiles: (): Response => jsonResponse(200, { deviceProfiles: ["pixel_6"] }),
  availableImages: (): Response => jsonResponse(200, { systemImages: [AVAILABLE_IMAGE] }),
};

type RouteName = keyof typeof DEFAULTS;

/** The requests the last installed backend did not stub. */
let unexpectedRequestLog: string[] = [];

interface Deferred {
  promise: Promise<Response>;
  resolve: (value: Response) => void;
}

/**
 * A response the test hands over by hand — the "still in flight" state.
 * A `Response`, not a body: the api client reads `res.json()` off it.
 */
function deferred(): Deferred {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Installs the fake backend and records which of the section's own lazy
 * endpoints were called, so a test can assert that a load only happens
 * once the surface that needs it is open.
 */
function installBackend(overrides: Partial<Record<RouteName, Handler>> = {}) {
  const handlers = { ...DEFAULTS, ...overrides };
  const calls: RouteName[] = [];
  const track = (name: RouteName, handler: Handler) => () => {
    calls.push(name);
    return handler();
  };
  const { fetchMock, unexpectedCalls } = mockFetch({
    "GET /api/server-info": () => jsonResponse(200, SERVER_INFO_FIXTURE),
    "GET /api/devices": () => jsonResponse(200, []),
    "GET /api/avds": track("avds", handlers.avds),
    "GET /api/system-images": track("systemImages", handlers.systemImages),
    "GET /api/device-profiles": track("deviceProfiles", handlers.deviceProfiles),
    "GET /api/system-images/available": track("availableImages", handlers.availableImages),
  });
  vi.stubGlobal("fetch", fetchMock);
  // Kept where the afterEach can assert it: a request no test stubbed would
  // otherwise surface only as a swallowed rejection inside the component.
  unexpectedRequestLog = unexpectedCalls;
  return { calls, unexpectedCalls };
}

/** Opens the "Create an emulator" form — the AVD picker's owner. */
async function openCreateForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByText("Create an emulator"));
}

describe("DevicesSection — the useAsyncData loads (issue #2411)", () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    // A request no test stubbed would otherwise surface only as a swallowed
    // rejection inside the component (mockFetch.ts's own contract).
    expect(unexpectedRequestLog).toEqual([]);
    vi.unstubAllGlobals();
  });

  describe("the AVD picker", () => {
    it("shows the loading state while the list is in flight", async () => {
      const pending = deferred();
      installBackend({ avds: () => pending.promise });
      const user = userEvent.setup();
      render(<DevicesSection />);

      await openCreateForm(user);
      expect(await screen.findByText("Loading AVDs…")).toBeInTheDocument();

      await act(async () => {
        pending.resolve(jsonResponse(200, { avds: ["pixel_7"] }));
      });
      await waitFor(() => expect(screen.queryByText("Loading AVDs…")).not.toBeInTheDocument());
    });

    it("lists the AVDs once the list arrives", async () => {
      installBackend();
      const user = userEvent.setup();
      render(<DevicesSection />);

      await openCreateForm(user);
      const picker = await screen.findByLabelText("Virtual device");
      expect(picker).toHaveValue("pixel_7");
    });

    it("shows the empty state when the machine has no AVDs", async () => {
      installBackend({ avds: () => jsonResponse(200, { avds: [] }) });
      const user = userEvent.setup();
      render(<DevicesSection />);

      await openCreateForm(user);
      expect(
        await screen.findByText("No virtual devices on this machine yet. Create one below."),
      ).toBeInTheDocument();
    });

    it("shows the error state when the list fails", async () => {
      installBackend({ avds: () => jsonResponse(500, { message: "avdmanager is missing" }) });
      const user = userEvent.setup();
      render(<DevicesSection />);

      await openCreateForm(user);
      expect(await screen.findByText("avdmanager is missing")).toBeInTheDocument();
      // The failure must not also claim the machine has no AVDs.
      expect(
        screen.queryByText("No virtual devices on this machine yet. Create one below."),
      ).not.toBeInTheDocument();
    });

    it("does not apply a superseded list", async () => {
      // The first list is requested when the form opens, then superseded by
      // closing and re-opening it. The stale response arrives last — it
      // must not overwrite the fresh one.
      const stale = deferred();
      const fresh = deferred();
      let call = 0;
      installBackend({
        avds: () => {
          call += 1;
          return call === 1 ? stale.promise : fresh.promise;
        },
      });
      const user = userEvent.setup();
      render(<DevicesSection />);

      await openCreateForm(user);
      // Close the form again — that supersedes the first request.
      await user.click(screen.getByText("Create an emulator"));
      // Re-open it: a second request goes out.
      await user.click(screen.getByText("Create an emulator"));

      await act(async () => {
        fresh.resolve(jsonResponse(200, { avds: ["fresh_avd"] }));
      });
      const picker = await screen.findByLabelText("Virtual device");
      expect(picker).toHaveValue("fresh_avd");

      await act(async () => {
        stale.resolve(jsonResponse(200, { avds: ["stale_avd"] }));
      });
      expect(picker).toHaveValue("fresh_avd");
    });
  });

  describe("the New AVD provisioning data", () => {
    it("does not load until the sub-form is opened", async () => {
      const { calls } = installBackend();
      const user = userEvent.setup();
      render(<DevicesSection />);

      await openCreateForm(user);
      await screen.findByLabelText("Virtual device");
      expect(calls).not.toContain("systemImages");
      expect(calls).not.toContain("deviceProfiles");

      await user.click(screen.getByText("+ New AVD"));
      await waitFor(() => expect(calls).toContain("systemImages"));
      expect(calls).toContain("deviceProfiles");
    });

    it("shows the loading state while the data is in flight", async () => {
      const pending = deferred();
      installBackend({ systemImages: () => pending.promise });
      const user = userEvent.setup();
      render(<DevicesSection />);

      await openCreateForm(user);
      await screen.findByLabelText("Virtual device");
      await user.click(screen.getByText("+ New AVD"));

      expect(
        await screen.findByText("Loading system images and device profiles…"),
      ).toBeInTheDocument();
    });

    it("shows the system image and device profile pickers once the data arrives", async () => {
      installBackend();
      const user = userEvent.setup();
      render(<DevicesSection />);

      await openCreateForm(user);
      await screen.findByLabelText("Virtual device");
      await user.click(screen.getByText("+ New AVD"));

      expect(await screen.findByLabelText("System image")).toHaveValue(SYSTEM_IMAGE.packagePath);
      expect(await screen.findByLabelText("Device profile")).toHaveValue("pixel_6");
    });

    it("shows the empty state when no system image is installed", async () => {
      installBackend({ systemImages: () => jsonResponse(200, { systemImages: [] }) });
      const user = userEvent.setup();
      render(<DevicesSection />);

      await openCreateForm(user);
      await screen.findByLabelText("Virtual device");
      await user.click(screen.getByText("+ New AVD"));

      expect(
        await screen.findByText(
          'No system images installed. Install one under "SDK system images" below.',
        ),
      ).toBeInTheDocument();
    });

    it("shows the error state when the data fails", async () => {
      installBackend({
        systemImages: () => jsonResponse(500, { message: "no sdkmanager here" }),
      });
      const user = userEvent.setup();
      render(<DevicesSection />);

      await openCreateForm(user);
      await screen.findByLabelText("Virtual device");
      await user.click(screen.getByText("+ New AVD"));

      expect(await screen.findByText("no sdkmanager here")).toBeInTheDocument();
      expect(
        screen.queryByText(
          'No system images installed. Install one under "SDK system images" below.',
        ),
      ).not.toBeInTheDocument();
    });
  });

  describe("the available-images list", () => {
    it("does not load until the section is expanded", async () => {
      const { calls } = installBackend();
      const user = userEvent.setup();
      render(<DevicesSection />);

      expect(calls).not.toContain("availableImages");

      await user.click(await screen.findByText("Load available images"));
      await waitFor(() => expect(calls).toContain("availableImages"));
    });

    it("shows the loading state while the list is in flight", async () => {
      const pending = deferred();
      installBackend({ availableImages: () => pending.promise });
      const user = userEvent.setup();
      render(<DevicesSection />);

      await user.click(await screen.findByText("Load available images"));
      expect(await screen.findByText("Loading available images…")).toBeInTheDocument();
    });

    it("lists the images once the list arrives", async () => {
      installBackend();
      const user = userEvent.setup();
      render(<DevicesSection />);

      await user.click(await screen.findByText("Load available images"));
      expect(await screen.findByText(AVAILABLE_IMAGE.packagePath)).toBeInTheDocument();
    });

    it("shows the empty state when no image is available", async () => {
      installBackend({ availableImages: () => jsonResponse(200, { systemImages: [] }) });
      const user = userEvent.setup();
      render(<DevicesSection />);

      await user.click(await screen.findByText("Load available images"));
      expect(await screen.findByText("No system images available.")).toBeInTheDocument();
    });

    it("shows the error state when the list fails", async () => {
      installBackend({
        availableImages: () => jsonResponse(500, { message: "sdkmanager timed out" }),
      });
      const user = userEvent.setup();
      render(<DevicesSection />);

      await user.click(await screen.findByText("Load available images"));
      expect(await screen.findByText("sdkmanager timed out")).toBeInTheDocument();
      expect(screen.queryByText("No system images available.")).not.toBeInTheDocument();
    });
  });
});
