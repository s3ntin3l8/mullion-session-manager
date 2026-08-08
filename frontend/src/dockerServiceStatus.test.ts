import { describe, it, expect } from "vitest";
import { dockerServiceStatus, isUpdateStillAvailable } from "./dockerServiceStatus.js";

describe("dockerServiceStatus", () => {
  it("maps running to a green dot", () => {
    expect(dockerServiceStatus("running")).toEqual({ label: "running", colorToken: "--g" });
  });

  it("maps restarting to an orange dot", () => {
    expect(dockerServiceStatus("restarting")).toEqual({
      label: "restarting",
      colorToken: "--o",
    });
  });

  it("maps dead to a red dot", () => {
    expect(dockerServiceStatus("dead")).toEqual({ label: "dead", colorToken: "--r" });
  });

  it("maps exited/paused/created/removing to a dim dot", () => {
    for (const state of ["exited", "paused", "created", "removing"]) {
      expect(dockerServiceStatus(state).colorToken).toBe("--dim");
      expect(dockerServiceStatus(state).label).toBe(state);
    }
  });

  it("falls back to a dim dot with the raw state as its label for an unknown state", () => {
    expect(dockerServiceStatus("some-future-state")).toEqual({
      label: "some-future-state",
      colorToken: "--dim",
    });
  });
});

describe("isUpdateStillAvailable", () => {
  it("is true when the last check found a newer image and the control hasn't caught up yet", () => {
    expect(isUpdateStillAvailable({ updateAvailable: true, latestImageId: "new" }, "current")).toBe(
      true,
    );
  });

  it("is false once the control's own imageId matches the checked latestImageId", () => {
    // The bug this guards: `updateChecks` is only ever written, never
    // invalidated — after a "Pull & restart" (or any other restart) lands
    // the new image, the badge must clear on the next dock poll rather
    // than staying lit forever.
    expect(isUpdateStillAvailable({ updateAvailable: true, latestImageId: "new" }, "new")).toBe(
      false,
    );
  });

  it("is false for a build-only / pull-failed check result (updateAvailable: false)", () => {
    expect(isUpdateStillAvailable({ updateAvailable: false }, "current")).toBe(false);
  });

  it("is false when there's no check result yet", () => {
    expect(isUpdateStillAvailable(undefined, "current")).toBe(false);
  });

  it("is false when the control has no known imageId (not a docker control)", () => {
    expect(isUpdateStillAvailable({ updateAvailable: true, latestImageId: "new" }, undefined)).toBe(
      false,
    );
  });
});
