// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommentComposer, ReviewComposer, ThreadActions } from "./Composer.js";

describe("CommentComposer", () => {
  it("posts the trimmed body and clears the box", async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<CommentComposer label="Comment on this issue" onSubmit={onSubmit} />);
    const box = screen.getByRole("textbox", { name: "Comment on this issue" });
    const button = screen.getByRole("button", { name: "Comment" });
    expect(button).toBeDisabled();
    await userEvent.type(box, "   ");
    expect(button).toBeDisabled();
    await userEvent.type(box, "looks good ");
    await userEvent.click(button);
    expect(onSubmit).toHaveBeenCalledWith("looks good");
    expect(box).toHaveValue("");
  });

  it("keeps the draft and shows the error when posting fails", async () => {
    const onSubmit = vi.fn(() => Promise.reject(new Error("no write access")));
    render(<CommentComposer label="c" onSubmit={onSubmit} />);
    await userEvent.type(screen.getByRole("textbox", { name: "c" }), "hello");
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no write access");
    expect(screen.getByRole("textbox", { name: "c" })).toHaveValue("hello");
  });

  it("submits on Ctrl+Enter and offers Cancel when asked", async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    const onCancel = vi.fn();
    render(<CommentComposer label="c" onSubmit={onSubmit} onCancel={onCancel} />);
    await userEvent.type(
      screen.getByRole("textbox", { name: "c" }),
      "hi{Control>}{Enter}{/Control}",
    );
    expect(onSubmit).toHaveBeenCalledWith("hi");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe("ReviewComposer", () => {
  it("approves without a body, but needs one to comment or request changes", async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<ReviewComposer onSubmit={onSubmit} />);
    expect(screen.getByRole("button", { name: "Comment" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Request changes" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onSubmit).toHaveBeenLastCalledWith("APPROVE", "");

    const box = screen.getByRole("textbox", { name: "Review summary" });
    await userEvent.type(box, "please fix");
    await userEvent.click(screen.getByRole("button", { name: "Request changes" }));
    expect(onSubmit).toHaveBeenLastCalledWith("REQUEST_CHANGES", "please fix");
    expect(box).toHaveValue("");

    await userEvent.type(box, "a note");
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(onSubmit).toHaveBeenLastCalledWith("COMMENT", "a note");
  });

  it("shows GitHub's refusal and keeps the draft", async () => {
    const onSubmit = vi.fn(() => Promise.reject(new Error("Can not approve your own PR")));
    render(<ReviewComposer onSubmit={onSubmit} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Review summary" }), "ok");
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Can not approve your own PR");
    expect(screen.getByRole("textbox", { name: "Review summary" })).toHaveValue("ok");
  });
});

describe("ThreadActions", () => {
  it("opens a reply box, posts and closes it", async () => {
    const onReply = vi.fn(() => Promise.resolve());
    render(<ThreadActions resolved={false} onReply={onReply} onResolve={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Reply" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Reply" }), "done");
    await userEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(onReply).toHaveBeenCalledWith("done");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("cancels a reply", async () => {
    render(<ThreadActions resolved={false} onReply={vi.fn()} onResolve={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Reply" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("resolves, and shows a failure", async () => {
    const onResolve = vi
      .fn()
      .mockRejectedValueOnce(new Error("no write access"))
      .mockResolvedValueOnce(undefined);
    render(<ThreadActions resolved={false} onReply={vi.fn()} onResolve={onResolve} />);
    await userEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no write access");
    await userEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(onResolve).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers no Resolve on a resolved thread", () => {
    render(<ThreadActions resolved onReply={vi.fn()} onResolve={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reply" })).toBeInTheDocument();
  });
});
