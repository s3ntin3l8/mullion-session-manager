// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommentComposer, ConversationComposer, ThreadActions } from "./Composer.js";

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

describe("ConversationComposer", () => {
  const me = { kind: "user", login: "me" } as const;
  const box = () => screen.getByRole("textbox", { name: "Comment or review" });

  it("approves without a body, but needs one to comment or request changes", async () => {
    const onComment = vi.fn(() => Promise.resolve());
    const onReview = vi.fn(() => Promise.resolve());
    const onClose = vi.fn();
    render(
      <ConversationComposer
        onComment={onComment}
        onReview={onReview}
        identity={me}
        prAuthor="someone"
        onClose={onClose}
      />,
    );
    expect(screen.getByRole("button", { name: "Comment" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Request changes" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onReview).toHaveBeenLastCalledWith("APPROVE", "");
    expect(onClose).toHaveBeenCalledTimes(1);

    await userEvent.type(box(), "please fix");
    await userEvent.click(screen.getByRole("button", { name: "Request changes" }));
    expect(onReview).toHaveBeenLastCalledWith("REQUEST_CHANGES", "please fix");
    expect(box()).toHaveValue("");

    await userEvent.type(box(), "a note");
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(onComment).toHaveBeenLastCalledWith("a note");
    expect(onReview).toHaveBeenCalledTimes(2);
  });

  it("posts only a comment where no review can be submitted", async () => {
    const onComment = vi.fn(() => Promise.resolve());
    render(<ConversationComposer onComment={onComment} onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Request changes" })).toBeNull();
    await userEvent.type(box(), "hi{Control>}{Enter}{/Control}");
    expect(onComment).toHaveBeenCalledWith("hi");
  });

  it("shows GitHub's refusal and keeps the draft", async () => {
    const onReview = vi.fn(() => Promise.reject(new Error("Can not approve your own PR")));
    const onClose = vi.fn();
    render(
      <ConversationComposer
        onComment={vi.fn()}
        onReview={onReview}
        identity={me}
        prAuthor="someone"
        onClose={onClose}
      />,
    );
    await userEvent.type(box(), "ok");
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Can not approve your own PR");
    expect(box()).toHaveValue("ok");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("says who it posts as, and offers a verdict only to the account itself", async () => {
    const props = { onComment: vi.fn(), onReview: vi.fn(), onClose: vi.fn() };
    const { rerender } = render(
      <ConversationComposer {...props} identity={me} prAuthor="someone" />,
    );
    expect(screen.getByText("Posts as @me")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();

    // Your own PR: GitHub would refuse a verdict, so none is offered.
    rerender(<ConversationComposer {...props} identity={me} prAuthor="me" />);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Request changes" })).toBeNull();
    expect(screen.getByRole("button", { name: "Comment" })).toBeInTheDocument();

    // Logins are case-insensitive: your own PR under another casing is still yours.
    rerender(<ConversationComposer {...props} identity={me} prAuthor="ME" />);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();

    // The App's bot: a verdict from it does not count, so comment only.
    rerender(
      <ConversationComposer
        {...props}
        identity={{ kind: "app", login: "mullion-session-manager" }}
        prAuthor="someone"
      />,
    );
    expect(screen.getByText(/Posts as @mullion-session-manager \(Mullion App/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();

    // No identity known: comment only, nothing claimed.
    rerender(<ConversationComposer {...props} identity={null} prAuthor="someone" />);
    expect(screen.queryByText(/Posts as/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("closes on Escape and on Cancel", async () => {
    const onClose = vi.fn();
    render(<ConversationComposer onComment={vi.fn()} onClose={onClose} />);
    await userEvent.type(box(), "{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("Posts as (#2049)", () => {
  it("names the identity under an issue comment box and a thread reply box", async () => {
    const me = { kind: "user", login: "me" } as const;
    const { unmount } = render(
      <CommentComposer label="Comment on this issue" identity={me} onSubmit={vi.fn()} />,
    );
    expect(screen.getByText("Posts as @me")).toBeInTheDocument();
    unmount();

    render(<ThreadActions resolved={false} identity={me} onReply={vi.fn()} onResolve={vi.fn()} />);
    expect(screen.queryByText("Posts as @me")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(screen.getByText("Posts as @me")).toBeInTheDocument();
  });

  it("says nothing when the identity is unknown", () => {
    render(<CommentComposer label="Comment" identity={null} onSubmit={vi.fn()} />);
    expect(screen.queryByText(/Posts as/)).toBeNull();
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
