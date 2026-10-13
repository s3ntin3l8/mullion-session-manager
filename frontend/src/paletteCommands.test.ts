import { describe, it, expect, vi } from "vitest";
import {
  buildPaletteCommands,
  searchPaletteCommands,
  type PaletteCommandContext,
} from "./paletteCommands.js";

function ctx(over: Partial<PaletteCommandContext> = {}) {
  const open = {
    github: vi.fn(),
    git: vi.fn(),
    agentRules: vi.fn(),
    fileEditor: vi.fn(),
    projectBriefing: vi.fn(),
    projectSetup: vi.fn(),
    dockConfig: vi.fn(),
    skills: vi.fn(),
    browser: vi.fn(),
    browserUrl: vi.fn(),
    integrationsSettings: vi.fn(),
    blankBrowser: vi.fn(),
  };
  const context: PaletteCommandContext = {
    projectId: 5,
    projectName: "mullion",
    favoriteUrls: [],
    open,
    ...over,
  };
  return { context, open };
}

const titles = (placement: "top" | "project", c: ReturnType<typeof buildPaletteCommands>) =>
  c.filter((x) => x.placement === placement).map((x) => x.title);

describe("buildPaletteCommands", () => {
  it("lists the top-level entries and puts the setup entries under the Project drill-in", () => {
    const commands = buildPaletteCommands(ctx().context);

    expect(titles("top", commands)).toEqual([
      "GitHub: mullion",
      "Git: mullion",
      "Project: mullion",
      "Preview: mullion",
      "Manage integrations…",
      "New preview tab",
    ]);
    expect(titles("project", commands)).toEqual([
      "Agent Rules",
      "Mullion Briefing",
      "Scaffold Mullion",
      "Dock",
      "Skills",
      "Edit project files",
    ]);
    expect(commands.filter((c) => c.drillIn).map((c) => c.id)).toEqual(["project"]);
  });

  it("wires each command to its opener with the project id", () => {
    const { context, open } = ctx();
    const byId = Object.fromEntries(buildPaletteCommands(context).map((c) => [c.id, c]));

    byId["github"].run();
    byId["git"].run();
    byId["agent-rules"].run();
    byId["project-briefing"].run();
    byId["project-setup"].run();
    byId["dock-config"].run();
    byId["skills"].run();
    byId["file-editor"].run();
    byId["preview"].run();
    byId["integrations-settings"].run();
    byId["blank-browser"].run();

    for (const key of [
      "github",
      "git",
      "agentRules",
      "projectBriefing",
      "projectSetup",
      "dockConfig",
      "skills",
      "fileEditor",
      "browser",
    ] as const) {
      expect(open[key]).toHaveBeenCalledWith(5);
    }
    expect(open.integrationsSettings).toHaveBeenCalledWith();
    expect(open.blankBrowser).toHaveBeenCalledWith();
  });

  it("adds a top-level row per favorited URL that opens it", () => {
    const { context, open } = ctx({
      favoriteUrls: [{ id: 1, url: "http://localhost:3000", label: "App" }],
    });
    const url = buildPaletteCommands(context).find((c) => c.id === "url-1")!;

    expect(url.title).toBe("App: mullion");
    expect(url.subtitle).toBe("http://localhost:3000");
    url.run();
    expect(open.browserUrl).toHaveBeenCalledWith(5, "http://localhost:3000", "App");
  });

  it("falls back to 'this project' when the name is unknown", () => {
    const commands = buildPaletteCommands(ctx({ projectName: null }).context);
    expect(commands.find((c) => c.id === "github")!.title).toBe("GitHub: this project");
  });

  it("offers only the project-independent entries when there is no project", () => {
    const commands = buildPaletteCommands(ctx({ projectId: null, projectName: null }).context);
    expect(commands.map((c) => c.id)).toEqual(["integrations-settings", "blank-browser"]);
  });

  it("offers Toggle right sidebar only when an opener is provided", () => {
    const { context } = ctx();
    expect(buildPaletteCommands(context).some((c) => c.id === "toggle-right-sidebar")).toBe(false);

    const toggle = vi.fn();
    const withToggle = buildPaletteCommands({
      ...context,
      open: { ...context.open, toggleRightSidebar: toggle },
    });
    const command = withToggle.find((c) => c.id === "toggle-right-sidebar")!;
    expect(command.placement).toBe("top");
    command.run();
    expect(toggle).toHaveBeenCalledTimes(1);
    // Project-independent: still offered with no project.
    const noProject = buildPaletteCommands({
      ...context,
      projectId: null,
      open: { ...context.open, toggleRightSidebar: toggle },
    });
    expect(noProject.map((c) => c.id)).toContain("toggle-right-sidebar");
  });

  it("the drill-in row's run is a harmless no-op (the palette handles it)", () => {
    const drill = buildPaletteCommands(ctx().context).find((c) => c.drillIn)!;
    expect(() => drill.run()).not.toThrow();
  });
});

describe("searchPaletteCommands", () => {
  const commands = buildPaletteCommands(ctx().context);
  const ids = (q: string) => searchPaletteCommands(commands, q).map((c) => c.id);

  it("returns nothing for a blank or whitespace query", () => {
    expect(ids("")).toEqual([]);
    expect(ids("   ")).toEqual([]);
  });

  it("matches title, keyword, and the 'Project <title>' breadcrumb, case-insensitively", () => {
    expect(ids("SKILLS")).toEqual(["skills"]);
    expect(ids("monitors")).toEqual(["dock-config"]);
    expect(ids("project skills")).toEqual(["skills"]);
  });

  it("never returns the drill-in row", () => {
    expect(ids("mullion")).not.toContain("project");
  });

  it("does not match on subtitles", () => {
    // "CLAUDE.md" appears only in Agent Rules' subtitle.
    expect(ids("claude")).toEqual([]);
  });
});
