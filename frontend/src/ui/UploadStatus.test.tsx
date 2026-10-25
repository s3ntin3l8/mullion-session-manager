// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UploadStatus } from "./UploadStatus.js";

const progress = (over = {}) => ({
  files: 4,
  filesDone: 1,
  bytes: 2048,
  bytesDone: 1024,
  current: "photos/a.png",
  ...over,
});

describe("UploadStatus", () => {
  it("renders nothing when idle with no errors", () => {
    const { container } = render(
      <UploadStatus progress={null} errors={[]} onCancel={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows file and byte progress, the current file, and cancels", async () => {
    const onCancel = vi.fn();
    render(
      <UploadStatus progress={progress()} errors={[]} onCancel={onCancel} onDismiss={vi.fn()} />,
    );
    expect(screen.getByText(/Uploading 2\/4/)).toBeInTheDocument();
    expect(screen.getByText(/1\.0? ?KB of 2 ?KB|1024 B|1 KB of 2 KB/)).toBeInTheDocument();
    expect(screen.getByText("photos/a.png")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    await userEvent.setup().click(screen.getByRole("button", { name: "Cancel upload" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("never counts past the last file and handles an all-empty batch", () => {
    render(
      <UploadStatus
        progress={progress({ files: 2, filesDone: 2, bytes: 0, bytesDone: 0, current: null })}
        errors={[]}
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/Uploading 2\/2/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  });

  it.each([
    [512, "512 B"],
    [5 * 1024, "5 KB"],
    [3 * 1024 * 1024, "3.0 MB"],
    [2 * 1024 * 1024 * 1024, "2.00 GB"],
  ])("formats %i bytes as %s", (bytes, text) => {
    render(
      <UploadStatus
        progress={progress({ bytes, bytesDone: bytes })}
        errors={[]}
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(new RegExp(`of ${text}`))).toBeInTheDocument();
  });

  it("lists up to five errors then summarises the rest, and dismisses", async () => {
    const onDismiss = vi.fn();
    const errors = Array.from({ length: 8 }, (_, i) => `f${i}.txt already exists`);
    render(
      <UploadStatus progress={null} errors={errors} onCancel={vi.fn()} onDismiss={onDismiss} />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByText("…and 3 more")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Dismiss upload errors" }));
    expect(onDismiss).toHaveBeenCalled();
  });
});
