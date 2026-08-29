// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectBriefingPanel } from "./ProjectBriefingPanel.js";
import { jsonResponse } from "./test/jsonResponse.js";

// Same "route a mocked fetch by URL/method, unhandled requests reject
// loudly" convention as AgentRulesPanel.test.tsx's own mockFetch — this
// panel has no list to fetch, just one GET/PUT/DELETE over a single row.
function mockFetch(opts: {
  get?: () => Response | Promise<Response>;
  write?: (body: unknown) => Response | Promise<Response>;
  del?: () => Response | Promise<Response>;
}) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/tooling") && method === "GET") {
      return Promise.resolve(opts.get ? opts.get() : new Response(null, { status: 200 }));
    }
    if (url.includes("/tooling") && method === "PUT") {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      return Promise.resolve(opts.write ? opts.write(body) : new Response(null, { status: 500 }));
    }
    if (url.includes("/tooling") && method === "DELETE") {
      return Promise.resolve(opts.del ? opts.del() : new Response(null, { status: 204 }));
    }
    return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
  });
}

describe("ProjectBriefingPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a loading state before the briefing resolves", () => {
    vi.stubGlobal("fetch", mockFetch({ get: () => new Promise(() => {}) }));
    render(<ProjectBriefingPanel params={{ projectId: 1 }} />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("offers a manual Retry button on initial load failure, which succeeds on click", async () => {
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      mockFetch({
        get: () => {
          attempt++;
          if (attempt === 1) return Promise.reject(new Error("network error"));
          return jsonResponse(200, { briefing: "existing briefing" });
        },
      }),
    );
    const user = userEvent.setup();
    render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

    const retryButton = await screen.findByText("Retry");
    expect(screen.getByText("Couldn't load this project's briefing.")).toBeInTheDocument();

    await user.click(retryButton);

    expect(await screen.findByDisplayValue("existing briefing")).toBeInTheDocument();
    expect(attempt).toBe(2);
  });

  it("shows an empty, placeholder-guided editor when the project has no DB briefing yet", async () => {
    vi.stubGlobal("fetch", mockFetch({ get: () => jsonResponse(200, { briefing: null }) }));
    render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

    const textarea = await screen.findByPlaceholderText(/No Mullion briefing set/);
    expect(textarea).toHaveValue("");
    // No row exists yet, so there's nothing to delete.
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
  });

  it("loads an existing briefing into the editor and offers Delete", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ get: () => jsonResponse(200, { briefing: "operator instructions" }) }),
    );
    render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

    expect(await screen.findByDisplayValue("operator instructions")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("saves edited content via PUT and reflects the updated value", async () => {
    const fetchMock = mockFetch({
      get: () => jsonResponse(200, { briefing: null }),
      write: (body) => jsonResponse(200, { briefing: (body as { briefing: string }).briefing }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

    const textarea = await screen.findByPlaceholderText(/No Mullion briefing set/);
    await user.type(textarea, "new briefing text");

    const saveButton = screen.getByText("Save");
    expect(saveButton).not.toBeDisabled();
    await user.click(saveButton);

    expect(await screen.findByText("Save")).toBeDisabled();
    const putCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
    );
    expect(putCall).toBeDefined();
    expect(JSON.parse((putCall![1] as RequestInit).body as string)).toEqual({
      briefing: "new briefing text",
    });
    // Delete now appears — the panel treats the just-saved row as existing.
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  // Same "don't unconditionally clear dirty" guard as AgentRulesPanel's own
  // handleSave (Hermes review, PR #458) — a save in flight must not silently
  // mark keystrokes typed during the round trip as saved.
  it("keeps dirty (and Save enabled) if the draft changed again while a save was in flight", async () => {
    let resolveWrite: (res: Response) => void;
    const writePromise = new Promise<Response>((resolve) => {
      resolveWrite = resolve;
    });
    vi.stubGlobal(
      "fetch",
      mockFetch({
        get: () => jsonResponse(200, { briefing: "base" }),
        write: () => writePromise,
      }),
    );
    const user = userEvent.setup();
    render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

    const textarea = await screen.findByDisplayValue("base");
    await user.type(textarea, " first edit");
    await user.click(screen.getByText("Save"));
    expect(screen.getByText("Saving…")).toBeInTheDocument();

    await user.type(textarea, " more");

    resolveWrite!(jsonResponse(200, { briefing: "base first edit" }));
    await screen.findByText("Save");

    expect(screen.getByText("Save")).not.toBeDisabled();
    expect(screen.getByDisplayValue("base first edit more")).toBeInTheDocument();
  });

  it("deletes the row via DELETE, clearing the editor to the empty/no-briefing state", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        get: () => jsonResponse(200, { briefing: "to be deleted" }),
        del: () => new Response(null, { status: 204 }),
      }),
    );
    const user = userEvent.setup();
    render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

    await screen.findByDisplayValue("to be deleted");
    // ConfirmButton requires arming before it fires — same "click again to
    // confirm" pattern as AgentRulesPanel's own delete button.
    const deleteButton = screen.getByTitle(/Delete this project's Mullion briefing\?/);
    await user.click(deleteButton);
    await user.click(deleteButton);

    expect(await screen.findByPlaceholderText(/No Mullion briefing set/)).toBeInTheDocument();
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
  });

  it("requires arming before firing — a single click does not delete", async () => {
    const delSpy = vi.fn(() => new Response(null, { status: 204 }));
    vi.stubGlobal(
      "fetch",
      mockFetch({ get: () => jsonResponse(200, { briefing: "content" }), del: delSpy }),
    );
    const user = userEvent.setup();
    render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

    await screen.findByDisplayValue("content");
    await user.click(screen.getByTitle(/Delete this project's Mullion briefing\?/));
    expect(delSpy).not.toHaveBeenCalled();
  });

  it("shows an error message when saving fails, without losing the draft", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        get: () => jsonResponse(200, { briefing: "base" }),
        write: () => jsonResponse(400, { message: "Briefing is too large" }),
      }),
    );
    const user = userEvent.setup();
    render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

    const textarea = await screen.findByDisplayValue("base");
    await user.type(textarea, " more");
    await user.click(screen.getByText("Save"));

    expect(await screen.findByText("Briefing is too large")).toBeInTheDocument();
    expect(screen.getByDisplayValue("base more")).toBeInTheDocument();
  });

  // Hermes review, PR #893 — the byte cap used to be invisible until Save
  // 400s with a byte count.
  it("shows a live byte-count hint and disables Save once the draft exceeds the byte cap", async () => {
    vi.stubGlobal("fetch", mockFetch({ get: () => jsonResponse(200, { briefing: null }) }));
    const user = userEvent.setup();
    render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

    const textarea = await screen.findByPlaceholderText(/No Mullion briefing set/);
    await user.type(textarea, "short");
    expect(screen.getByText(/5 \/ 8,192 bytes/)).toBeInTheDocument();
    expect(screen.getByText("Save")).not.toBeDisabled();

    await user.paste("a".repeat(8193));
    expect(await screen.findByText(/over the limit/)).toBeInTheDocument();
    expect(screen.getByText("Save")).toBeDisabled();
  });

  it("Discard restores the last-saved value and disables itself", async () => {
    vi.stubGlobal("fetch", mockFetch({ get: () => jsonResponse(200, { briefing: "base" }) }));
    const user = userEvent.setup();
    render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

    const textarea = await screen.findByDisplayValue("base");
    await user.type(textarea, " edited");
    expect(screen.getByText("Discard")).toBeInTheDocument();

    await user.click(screen.getByText("Discard"));
    expect(screen.getByDisplayValue("base")).toBeInTheDocument();
    expect(screen.queryByText("Discard")).not.toBeInTheDocument();
  });
});
