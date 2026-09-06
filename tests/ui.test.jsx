import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  render,
  renderHook,
  screen,
  within,
  waitFor,
  fireEvent,
  act as reactAct,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App, MD, RunDialog, MissionDialog, Sentinel } from "../src/main.jsx";
import { RunDetail } from "../src/features/session.jsx";
import { TerminalView } from "../src/features/terminal.jsx";
import { WorkflowPlanner } from "../src/features/workflow-planner.jsx";
import { ProjectDialog } from "../src/features/dialogs.jsx";
import { TeamSettings, TeamReviews, TeamBadge } from "../src/features/team.jsx";
import {
  ProjectStart,
  SnapshotSelection,
} from "../src/features/onboarding.jsx";
import { Preview } from "../src/features/preview.jsx";
import { HomePage } from "../src/features/home.jsx";
import { BrainView } from "../src/features/brain.jsx";
import {
  createMotion,
  tickMotion,
  useGraphMotion,
} from "../src/features/brain-motion.js";
import {
  BrainGraph,
  buildNoteGraph,
  layoutNotes,
  fitNoteGraph,
  initialNoteGraph,
  noteTarget,
} from "../src/features/brain-graph.jsx";
import {
  QuickSession,
  WorkspaceSidebar,
  SessionOptions,
  NewWorkspaceMenu,
} from "../src/features/workspace.jsx";

// Component interaction tests; these do not claim to replace visual browser QA.
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    loadAddon() {}
    open() {}
    onData() {}
    onResize() {}
    focus() {}
    write() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const emptyState = {
  csrf: "local-test-token",
  projects: [],
  runs: [],
  missions: [],
  findings: [],
  status: {
    authenticated: true,
    version: "test-cli",
    concurrency: 3,
    dataDir: "/test/data",
  },
};
const brainNotes = [
  {
    filename: "Home.md",
    title: "Home",
    generated: true,
    content: "# Vault home",
    links: ["Decisions", "Development"],
  },
  {
    filename: "Decisions.md",
    title: "Decisions",
    content: "# Decisions\n\nKeep modules small.",
    links: ["Home", "Development|Build"],
  },
  {
    filename: "Development.md",
    title: "Development",
    generated: true,
    content: "# Development",
    links: ["Home"],
  },
  {
    filename: "Session abc.md",
    title: "Session abc",
    generated: true,
    content: "---\nkind: session-receipt\n---\n# Session",
    links: ["Home"],
  },
  {
    filename: "Idea.md",
    title: "Idea",
    proposal: true,
    stale: true,
    content: "# Idea",
    links: [],
  },
];
test("brain graph derives only real links, resolves aliases and bounds large vaults", () => {
  const graph = buildNoteGraph([
    ...brainNotes,
    {
      filename: "Extra.md",
      title: "Extra",
      links: ["Missing", "Home.md#Source|Overview", "Extra"],
    },
  ]);
  expect(noteTarget("Home.md#Source|Overview")).toBe("Home");
  expect(graph.nodes).toHaveLength(6);
  expect(graph.edges).toHaveLength(5);
  expect(graph.nodes.find((n) => n.id === "Session abc.md").kind).toBe(
    "session",
  );
  expect(graph.nodes.some((n) => n.title === "Missing")).toBe(false);
  const positions = layoutNotes(graph);
  expect(
    positions.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)),
  ).toBe(true);
  expect(layoutNotes(graph)).toEqual(positions);
  const large = buildNoteGraph(
    Array.from({ length: 300 }, (_, i) => ({
      filename: `Note ${i}.md`,
      title: `Note ${i}`,
      links: [],
    })),
  );
  expect(large.nodes).toHaveLength(250);
  expect(large.omitted).toBe(50);
});
test("graph physics settles, keeps a dragged node pinned and moves its neighbours", () => {
  const graph = buildNoteGraph(brainNotes),
    layout = layoutNotes(graph);
  const forces = { center: 1, repel: 1, link: 1, distance: 190 };
  const sim = createMotion(graph, layout);
  const before = sim.nodes.map((n) => ({ ...n }));
  sim.pin = { id: "Home.md", x: 800, y: 150 };
  for (let i = 0; i < 30; i++) tickMotion(sim, forces);
  expect(sim.byId.get("Home.md").x).toBe(800);
  expect(sim.byId.get("Home.md").y).toBe(150);
  expect(sim.byId.get("Decisions.md").x).not.toBe(
    before.find((n) => n.id === "Decisions.md").x,
  );
  sim.pin = null;
  let ticks = 0;
  while (tickMotion(sim, forces) && ticks++ < 400) {}
  expect(ticks).toBeLessThan(400);
  expect(
    sim.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)),
  ).toBe(true);
  const next = createMotion(graph, layout, sim.nodes);
  expect(next.nodes.map((n) => [n.x, n.y])).toEqual(
    sim.nodes.map((n) => [n.x, n.y]),
  );
  expect(createMotion(graph, layout, sim.nodes, true).nodes).toEqual(
    createMotion(graph, layout).nodes,
  );
});
test("graph animation pauses offscreen, reheats on drag, stops when settled and cleans up", async () => {
  const frames = new Map();
  let frameId = 0,
    mediaChange,
    hidden = false;
  const media = {
    matches: false,
    addEventListener: vi.fn((_, fn) => {
      mediaChange = fn;
    }),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("matchMedia", () => media);
  vi.stubGlobal("requestAnimationFrame", (fn) => {
    frames.set(++frameId, fn);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id) => frames.delete(id));
  const visibility = vi
    .spyOn(document, "hidden", "get")
    .mockImplementation(() => hidden);
  const graph = buildNoteGraph(brainNotes),
    layout = layoutNotes(graph),
    forces = { center: 1, repel: 1, link: 1, distance: 190 };
  const view = renderHook(() => useGraphMotion(graph, layout, forces));
  let time = 0;
  const step = async () =>
    reactAct(() => {
      const pending = [...frames.values()];
      frames.clear();
      time += 17;
      pending.forEach((fn) => fn(time));
    });
  try {
    expect(view.result.current.running).toBe(true);
    const before = view.result.current.points.get("Home.md").x;
    await step();
    await step();
    expect(view.result.current.points.get("Home.md").x).not.toBe(before);
    hidden = true;
    await reactAct(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(frames.size).toBe(0);
    expect(view.result.current.running).toBe(false);
    hidden = false;
    await reactAct(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(frames.size).toBe(1);
    for (let i = 0; i < 350 && frames.size; i++) await step();
    expect(frames.size).toBe(0);
    expect(view.result.current.running).toBe(false);
    await reactAct(() =>
      view.result.current.drag("Home.md", { x: 900, y: 100 }),
    );
    expect(view.result.current.points.get("Home.md")).toEqual({
      x: 900,
      y: 100,
    });
    expect(frames.size).toBe(1);
    await step();
    expect(view.result.current.points.get("Home.md")).toEqual({
      x: 900,
      y: 100,
    });
    await reactAct(() => view.result.current.release());
    await step();
    expect(view.result.current.points.get("Home.md").x).not.toBe(900);
    await reactAct(() => view.result.current.stop());
    expect(frames.size).toBe(0);
    await reactAct(() => view.result.current.replay());
    expect(frames.size).toBe(1);
    media.matches = true;
    await reactAct(() => mediaChange());
    expect(view.result.current.reduced).toBe(true);
    expect(frames.size).toBe(0);
    expect(view.result.current.points.get("Home.md").x).toBe(
      layout.find((n) => n.id === "Home.md").x,
    );
  } finally {
    view.unmount();
    visibility.mockRestore();
  }
  expect(frames.size).toBe(0);
  expect(media.removeEventListener).toHaveBeenCalled();
});
test("graph framing centres small and large layouts and keeps their nodes inside the view", () => {
  expect(fitNoteGraph([])).toEqual({ x: 0, y: 0, zoom: 1 });
  for (const points of [
    [{ x: 500, y: 350 }],
    layoutNotes(buildNoteGraph(brainNotes)),
    [
      { x: -2000, y: -1300 },
      { x: 1900, y: 2600 },
    ],
  ]) {
    const camera = fitNoteGraph(points);
    expect(camera.zoom).toBeGreaterThan(0);
    expect(camera.zoom).toBeLessThanOrEqual(1.5);
    for (const p of points) {
      const x = 500 + camera.x + (p.x - 500) * camera.zoom;
      const y = 350 + camera.y + (p.y - 350) * camera.zoom;
      expect(x).toBeGreaterThan(70);
      expect(x).toBeLessThan(930);
      expect(y).toBeGreaterThan(70);
      expect(y).toBeLessThan(620);
    }
  }
});
test("graph starts closer in using the available canvas while keeping large vaults framed", () => {
  expect(initialNoteGraph([{ x: 500, y: 350 }]).zoom).toBe(2.4);
  for (const points of [
    [],
    layoutNotes(buildNoteGraph(brainNotes)),
    [
      { x: -10000, y: -5000 },
      { x: 10000, y: 5000 },
    ],
  ]) {
    const camera = initialNoteGraph(points);
    expect(camera.zoom).toBeLessThanOrEqual(2.4);
    expect(Number.isFinite(camera.x) && Number.isFinite(camera.y)).toBe(true);
    for (const p of points) {
      const x = 500 + camera.x + (p.x - 500) * camera.zoom;
      const y = 350 + camera.y + (p.y - 350) * camera.zoom;
      expect(x).toBeGreaterThan(40);
      expect(x).toBeLessThan(960);
      expect(y).toBeGreaterThan(40);
      expect(y).toBeLessThan(660);
    }
  }
  const points = layoutNotes(buildNoteGraph(brainNotes));
  expect(initialNoteGraph(points).zoom).toBeGreaterThan(
    Math.min(1.2, fitNoteGraph(points).zoom),
  );
});
test("graph resize recentres the drawing without changing its pixel scale", async () => {
  let resize;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback) {
        resize = callback;
      }
      observe() {}
      disconnect() {
        disconnect();
      }
    },
  );
  const view = render(
    <BrainGraph
      notes={brainNotes}
      selected="Home.md"
      onSelect={() => {}}
      query=""
      onQuery={() => {}}
    />,
  );
  const canvas = view.container.querySelector(".brain-graph-canvas");
  const scale = () =>
    canvas.firstElementChild
      .getAttribute("transform")
      .match(/scale\(([^)]+)\)/)[1];
  await reactAct(() => resize([{ contentRect: { width: 640, height: 500 } }]));
  const before = scale();
  expect(Number(before)).toBe(
    initialNoteGraph(layoutNotes(buildNoteGraph(brainNotes)), 640, 500).zoom,
  );
  expect(canvas.getAttribute("viewBox")).toBe("0 0 640 500");
  expect(scale()).toBe(before);
  await reactAct(() => resize([{ contentRect: { width: 1400, height: 850 } }]));
  expect(canvas.getAttribute("viewBox")).toBe("0 0 1400 850");
  expect(scale()).toBe(before);
  view.unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});
test("brain graph filters types and local connections and supports keyboard note selection and zoom", async () => {
  const user = userEvent.setup(),
    select = vi.fn(),
    query = vi.fn();
  const view = render(
    <BrainGraph
      notes={brainNotes}
      selected="Decisions.md"
      onSelect={select}
      query=""
      onQuery={query}
    />,
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "Open note: Home" }), {
    key: "Enter",
  });
  expect(select).toHaveBeenCalledWith("Home.md");
  await user.click(screen.getByText("Filters", { exact: true }));
  await user.click(screen.getByRole("button", { name: "Local graph" }));
  expect(
    screen.queryByRole("button", { name: "Open note: Session abc" }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "Open note: Development" }),
  ).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Local graph" }));
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Note type" }),
    "proposal",
  );
  expect(screen.getByRole("button", { name: "Open note: Idea" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Open note: Home" })).toBeNull();
  const before = view.container
    .querySelector("svg.brain-graph-canvas > g")
    .getAttribute("transform");
  await user.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(
    view.container
      .querySelector("svg.brain-graph-canvas > g")
      .getAttribute("transform"),
  ).not.toBe(before);
  await user.click(screen.getByRole("button", { name: "Fit graph" }));
  view.rerender(
    <BrainGraph
      notes={brainNotes}
      selected="Decisions.md"
      onSelect={select}
      query="nothing-matches"
      onQuery={query}
    />,
  );
  expect(screen.getByText("No notes match these filters.")).toBeTruthy();
});
test("graph settings control display, groups, orphan visibility and forces and restore defaults", async () => {
  const user = userEvent.setup(),
    query = vi.fn();
  const view = render(
    <BrainGraph
      notes={[
        ...brainNotes,
        { filename: "Alone.md", title: "Alone", links: [], content: "" },
      ]}
      selected="Home.md"
      onSelect={() => {}}
      query=""
      onQuery={query}
    />,
  );
  expect(
    screen.queryByRole("complementary", { name: "Graph settings panel" }),
  ).toBeTruthy();
  expect(
    view.container.querySelectorAll(".brain-graph-controls details[open]"),
  ).toHaveLength(0);
  expect(
    view.container
      .querySelector(".graph-label text")
      .getAttribute("text-anchor"),
  ).toBe("middle");
  await user.click(
    screen.getByRole("button", { name: "Close graph settings" }),
  );
  expect(
    screen.queryByRole("complementary", { name: "Graph settings panel" }),
  ).toBeNull();
  expect(
    view.container.querySelectorAll("line.graph-edge").length,
  ).toBeGreaterThan(0);
  expect(
    view.container.querySelector(".graph-halo, .graph-label-bg"),
  ).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "Graph settings", exact: true }),
  );
  await user.click(screen.getByText("Filters", { exact: true }));
  await user.click(screen.getByRole("switch", { name: "Orphans" }));
  expect(screen.queryByRole("button", { name: "Open note: Alone" })).toBeNull();
  await user.click(screen.getByText("Groups", { exact: true }));
  await user.click(screen.getByRole("switch", { name: "Color by note type" }));
  expect(view.container.querySelector(".brain-graph").dataset.groups).toBe(
    "true",
  );
  await user.click(screen.getByText("Display", { exact: true }));
  const core = view.container.querySelector(
    '[data-note="Home.md"] .graph-core',
  );
  const size = Number(core.getAttribute("r"));
  fireEvent.change(screen.getByRole("slider", { name: "Node size" }), {
    target: { value: "2" },
  });
  expect(Number(core.getAttribute("r"))).toBe(size * 2);
  fireEvent.change(screen.getByRole("slider", { name: "Link thickness" }), {
    target: { value: "2" },
  });
  expect(
    view.container
      .querySelector(".brain-graph")
      .style.getPropertyValue("--graph-link-width"),
  ).toBe("2");
  await user.click(screen.getByText("Forces", { exact: true }));
  const position = view.container
    .querySelector('[data-note="Decisions.md"]')
    .getAttribute("transform");
  fireEvent.change(screen.getByRole("slider", { name: "Link distance" }), {
    target: { value: "300" },
  });
  expect(
    view.container
      .querySelector('[data-note="Decisions.md"]')
      .getAttribute("transform"),
  ).not.toBe(position);
  await user.click(
    screen.getByRole("button", { name: "Restore default graph settings" }),
  );
  expect(screen.getByRole("button", { name: "Open note: Alone" })).toBeTruthy();
  expect(view.container.querySelector(".brain-graph").dataset.groups).toBe(
    "false",
  );
  expect(Number(core.getAttribute("r"))).toBe(size);
  expect(screen.getByRole("slider", { name: "Link distance" }).value).toBe(
    "190",
  );
  expect(query).toHaveBeenCalledWith("");
});
test("brain opens linked notes beside the graph and guards unsaved edits", async () => {
  const user = userEvent.setup(),
    notify = vi.fn();
  const request = vi.fn(async () => ({
    ok: true,
    json: async () => ({ notes: brainNotes, vaultPath: "/test/vault" }),
  }));
  vi.stubGlobal("fetch", request);
  const project = { id: "p", name: "Project" };
  const view = render(
    <BrainView
      project={project}
      state={{ ...emptyState, projects: [project] }}
      act={(fn) => fn()}
      notify={notify}
    />,
  );
  await screen.findByRole("region", { name: "Project knowledge graph" });
  expect(screen.queryByRole("article")).toBeNull();
  expect(screen.getByRole("button", { name: "Show note panel" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Show note panel" }));
  expect(screen.getByRole("heading", { name: "Vault home" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Hide note panel" }));
  expect(screen.queryByRole("article")).toBeNull();
  fireEvent.keyDown(
    screen.getByRole("button", { name: "Open note: Decisions" }),
    { key: "Enter" },
  );
  expect(screen.getByRole("heading", { name: "Decisions" })).toBeTruthy();
  expect(screen.getByRole("article")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Edit note" }));
  await user.type(
    screen.getByRole("textbox", { name: "Markdown note" }),
    " Draft thought",
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "Open note: Home" }), {
    key: "Enter",
  });
  expect(notify).toHaveBeenCalledWith(
    "Save or cancel your note edits before opening another note.",
  );
  await user.click(screen.getByRole("button", { name: "Open file: Home" }));
  expect(
    screen
      .getByRole("button", { name: "Open file: Decisions" })
      .getAttribute("aria-current"),
  ).toBe("page");
  expect(
    screen.getByRole("textbox", { name: "Markdown note" }).value,
  ).toContain("Draft thought");
  expect(localStorage.getItem("fleet.note-draft.p.Decisions.md")).toContain(
    "Draft thought",
  );
  await user.click(screen.getByRole("button", { name: "Cancel", exact: true }));
  expect(localStorage.getItem("fleet.note-draft.p.Decisions.md")).toBeNull();
  await user.click(
    within(screen.getByRole("group", { name: "Brain view" })).getByRole(
      "button",
      { name: "Notes", exact: true },
    ),
  );
  expect(
    screen.queryByRole("region", { name: "Project knowledge graph" }),
  ).toBeNull();
  expect(view.container.querySelector(".notes-sidebar")).toBeTruthy();
  expect(
    request.mock.calls.every(
      ([, options]) => !options?.method || options.method === "GET",
    ),
  ).toBe(true);
});
test("brain file explorer browses all notes independently of graph filters and can collapse", async () => {
  const user = userEvent.setup(),
    notify = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ notes: brainNotes, vaultPath: "/test/vault" }),
    })),
  );
  const project = { id: "p", name: "Project" };
  render(
    <BrainView
      project={project}
      state={{ ...emptyState, projects: [project] }}
      act={(fn) => fn()}
      notify={notify}
    />,
  );
  const files = await screen.findByRole("complementary", {
    name: "Brain files",
  });
  expect(
    within(files).getAllByRole("button", { name: /^Open file:/ }),
  ).toHaveLength(brainNotes.length);
  await user.type(
    within(files).getByRole("textbox", { name: "Find a note" }),
    "Decisions",
  );
  expect(
    within(files).getAllByRole("button", { name: /^Open file:/ }),
  ).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Open note: Home" })).toBeTruthy();
  await user.click(
    within(files).getByRole("button", { name: "Open file: Decisions" }),
  );
  expect(screen.getByRole("article")).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "Open note: Decisions" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  await user.clear(within(files).getByRole("textbox", { name: "Find a note" }));
  fireEvent.keyDown(screen.getByRole("button", { name: "Open note: Home" }), {
    key: "Enter",
  });
  expect(
    within(files)
      .getByRole("button", { name: "Open file: Home" })
      .getAttribute("aria-current"),
  ).toBe("page");
  await user.type(
    within(files).getByRole("textbox", { name: "Find a note" }),
    "not-a-note",
  );
  expect(within(files).getByText("No matching notes.")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Hide file explorer" }));
  expect(
    screen.queryByRole("complementary", { name: "Brain files" }),
  ).toBeNull();
  expect(
    screen.getByRole("region", { name: "Project knowledge graph" }),
  ).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Show file explorer" }));
  expect(screen.getByRole("textbox", { name: "Find a note" }).value).toBe(
    "not-a-note",
  );
  await user.click(screen.getByRole("button", { name: "New brain note" }));
  expect(screen.getByRole("dialog", { name: "A new note" })).toBeTruthy();
  await user.click(
    within(screen.getByRole("dialog", { name: "A new note" })).getByRole(
      "button",
      { name: "Cancel", exact: true },
    ),
  );
  await user.clear(screen.getByRole("textbox", { name: "Find a note" }));
  vi.stubGlobal("matchMedia", (query) => ({
    matches: query.includes("max-width"),
    addEventListener() {},
    removeEventListener() {},
  }));
  await user.click(
    screen.getByRole("button", { name: "Open file: Decisions" }),
  );
  expect(
    screen.queryByRole("complementary", { name: "Brain files" }),
  ).toBeNull();
  expect(screen.getByRole("article")).toBeTruthy();
});
test("brain prevents duplicate note creation from overwriting existing content", async () => {
  const user = userEvent.setup(),
    notify = vi.fn();
  const request = vi.fn(async () => ({
    ok: true,
    json: async () => ({ notes: brainNotes, vaultPath: "/test/vault" }),
  }));
  vi.stubGlobal("fetch", request);
  const project = { id: "p", name: "Project" };
  render(
    <BrainView
      project={project}
      state={{ ...emptyState, projects: [project] }}
      act={(fn) => fn()}
      notify={notify}
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: "New note", exact: true }),
  );
  await user.type(screen.getByLabelText("Note title"), "decisions");
  await user.click(
    screen.getByRole("button", { name: "Create note", exact: true }),
  );
  expect(notify).toHaveBeenCalledWith(
    "A note with that name already exists. Choose another name.",
  );
  expect(
    request.mock.calls.every(
      ([, options]) => !options?.method || options.method === "GET",
    ),
  ).toBe(true);
});
test("brain automatically reloads new vault notes without starting an agent", async () => {
  vi.useFakeTimers();
  let notes = brainNotes;
  const request = vi.fn(async () => ({
    ok: true,
    json: async () => ({ notes, vaultPath: "/test/vault" }),
  }));
  vi.stubGlobal("fetch", request);
  const project = { id: "p", name: "Project" };
  let view;
  try {
    await reactAct(async () => {
      view = render(
        <BrainView
          project={project}
          state={{ ...emptyState, projects: [project] }}
          act={(fn) => fn()}
          notify={() => {}}
        />,
      );
    });
    expect(
      screen.queryByRole("button", { name: "Open note: New receipt" }),
    ).toBeNull();
    notes = [
      ...brainNotes,
      {
        filename: "New receipt.md",
        title: "New receipt",
        content: "# New receipt",
        generated: true,
        links: ["Home"],
      },
    ];
    await reactAct(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(
      screen.getByRole("button", { name: "Open note: New receipt" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Open file: New receipt" }),
    ).toBeTruthy();
    expect(
      request.mock.calls.every(
        ([, options]) => !options?.method || options.method === "GET",
      ),
    ).toBe(true);
    view.unmount();
    const count = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(8000);
    expect(request).toHaveBeenCalledTimes(count);
  } finally {
    view?.unmount();
    vi.useRealTimers();
  }
});
test("Home is the startup view and Continue restores the last conversation without running it", async () => {
  const user = userEvent.setup();
  const run = {
    id: "last",
    projectId: "p",
    title: "My last conversation",
    prompt: "Keep working",
    status: "review",
    sandbox: "read-only",
    files: [],
    scopes: [],
    dependencies: [],
    usage: {},
    createdAt: "2026-09-06T09:00:00Z",
  };
  const state = {
    ...emptyState,
    projects: [
      { id: "p", name: "Project", path: "/project" },
      { id: "empty", name: "Empty project", path: "/empty" },
    ],
    runs: [
      run,
      {
        ...run,
        id: "newer",
        title: "Newer background activity",
        updatedAt: "2026-09-06T11:00:00Z",
      },
    ],
  };
  localStorage.setItem("fleet.project", "p");
  localStorage.setItem("fleet.session", "last");
  localStorage.setItem("fleet.view", "sessions");
  localStorage.setItem("fleet.draft.last", "Unsent thought");
  const request = vi.fn(async (url) => ({
    ok: true,
    json: async () => (url === "/api/state" ? state : { ...run, events: [] }),
  }));
  vi.stubGlobal("fetch", request);
  const first = render(<App />);
  await screen.findByRole("heading", { name: "Your workspace" });
  expect(
    screen.queryByRole("region", { name: "Projects and sessions" }),
  ).toBeNull();
  expect(
    screen.queryByRole("heading", { name: run.title, level: 1 }),
  ).toBeNull();
  await user.click(
    screen.getByRole("button", {
      name: /Continue working: My last conversation/,
    }),
  );
  await screen.findByRole("heading", { name: run.title });
  expect(
    screen.getByRole("textbox", { name: "Follow-up instruction" }).value,
  ).toBe("Unsent thought");
  await user.click(screen.getByRole("button", { name: "Home", exact: true }));
  expect(screen.getByRole("heading", { name: "Your workspace" })).toBeTruthy();
  expect(localStorage.getItem("fleet.session")).toBe("last");
  await user.click(screen.getByRole("button", { name: /^Open Empty project/ }));
  await screen.findByRole("heading", { name: "No session selected" });
  await user.click(screen.getByRole("button", { name: "Home", exact: true }));
  expect(
    screen.getByRole("button", {
      name: /Continue working: My last conversation/,
    }),
  ).toBeTruthy();
  first.unmount();
  render(<App />);
  await screen.findByRole("heading", { name: "Your workspace" });
  expect(
    screen.getByRole("button", {
      name: /Continue working: My last conversation/,
    }),
  ).toBeTruthy();
  expect(
    request.mock.calls.some(([, options]) => options?.method === "POST"),
  ).toBe(false);
});
test("horizontal project navigation keeps Home and switches sidebar scope without losing drafts", async () => {
  const user = userEvent.setup();
  const projects = [
    { id: "one", name: "One", path: "/one" },
    { id: "two", name: "Two", path: "/two" },
  ];
  const runs = projects.map((p) => ({
    id: `run-${p.id}`,
    projectId: p.id,
    title: `${p.name} task`,
    prompt: "Existing task",
    status: "review",
    sandbox: "read-only",
    files: [],
    scopes: [],
    dependencies: [],
    usage: {},
    createdAt: "2026-09-06T09:00:00Z",
  }));
  const request = vi.fn(async (url) => ({
    ok: true,
    json: async () =>
      url === "/api/state"
        ? { ...emptyState, projects, runs }
        : { ...runs.find((r) => url.includes(r.id)), events: [] },
  }));
  vi.stubGlobal("fetch", request);
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "Open One — /one" }),
  );
  await screen.findByRole("heading", { name: "One task" });
  const sidebar = () =>
    screen.getByRole("region", { name: "Projects and sessions" });
  expect(within(sidebar()).getByText("One task")).toBeTruthy();
  expect(within(sidebar()).queryByText("Two")).toBeNull();
  expect(within(sidebar()).queryByText("Two task")).toBeNull();
  await user.type(
    screen.getByRole("textbox", { name: "Follow-up instruction" }),
    "Keep this draft",
  );
  await user.type(
    screen.getByRole("textbox", { name: "Filter projects and sessions" }),
    "One task",
  );
  await user.click(screen.getByRole("button", { name: "Hide session list" }));
  await user.click(
    screen.getByRole("button", { name: "All projects", exact: true }),
  );
  expect(
    screen
      .getByRole("button", { name: "All projects", exact: true })
      .getAttribute("aria-current"),
  ).toBe("page");
  expect(screen.queryByRole("heading", { name: "Your workspace" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "View all projects" }),
  ).toBeNull();
  expect(within(sidebar()).getByText("One task")).toBeTruthy();
  expect(within(sidebar()).getByText("Two task")).toBeTruthy();
  expect(
    screen.getByRole("textbox", { name: "Follow-up instruction" }).value,
  ).toBe("Keep this draft");
  await user.click(within(sidebar()).getByText("Two task"));
  await screen.findByRole("heading", { name: "Two task" });
  expect(within(sidebar()).getByText("One task")).toBeTruthy();
  await user.click(
    within(
      screen.getByRole("navigation", { name: "Workspace navigation" }),
    ).getByRole("button", { name: "Two — /two" }),
  );
  expect(within(sidebar()).queryByText("One task")).toBeNull();
  expect(within(sidebar()).getByText("Two task")).toBeTruthy();
  expect(
    screen.getByRole("textbox", { name: "Filter projects and sessions" }).value,
  ).toBe("");
  await user.click(
    within(
      screen.getByRole("navigation", { name: "Workspace navigation" }),
    ).getByRole("button", { name: "One — /one" }),
  );
  await screen.findByRole("heading", { name: "One task" });
  expect(
    screen.getByRole("textbox", { name: "Follow-up instruction" }).value,
  ).toBe("Keep this draft");
  await user.click(screen.getByRole("button", { name: "Home", exact: true }));
  expect(screen.getByRole("heading", { name: "Your workspace" })).toBeTruthy();
  const nav = screen.getByRole("navigation", { name: "Workspace navigation" });
  expect(
    within(nav)
      .getByRole("button", { name: "Home", exact: true })
      .getAttribute("aria-current"),
  ).toBe("page");
  expect(
    within(nav).getByRole("button", { name: "One — /one", exact: true }),
  ).toBeTruthy();
  expect(
    within(nav).getByRole("button", { name: "Two — /two", exact: true }),
  ).toBeTruthy();
  expect(
    within(nav).getAllByRole("button", { name: /^Close tab:/ }),
  ).toHaveLength(2);
  expect(screen.queryByLabelText("Select project")).toBeNull();
  await user.click(
    within(nav).getByRole("button", { name: "All projects", exact: true }),
  );
  expect(within(sidebar()).getByText("One task")).toBeTruthy();
  expect(within(sidebar()).getByText("Two task")).toBeTruthy();
  expect(
    request.mock.calls.some(([, options]) => options?.method === "POST"),
  ).toBe(false);
});
test("project tabs close without deleting work, persist across reload and reopen from plus", async () => {
  const user = userEvent.setup();
  const project = { id: "one", name: "One", path: "/one" };
  const run = {
    id: "r",
    projectId: "one",
    title: "Existing work",
    prompt: "Task",
    status: "review",
    sandbox: "read-only",
    scopes: [],
    files: [],
    dependencies: [],
    usage: {},
  };
  const state = {
    ...emptyState,
    projects: [project, { id: "two", name: "Two", path: "/two" }],
    runs: [run],
  };
  const request = vi.fn(async (url) => ({
    ok: true,
    json: async () => (url === "/api/state" ? state : { ...run, events: [] }),
  }));
  vi.stubGlobal("fetch", request);
  const first = render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "One — /one", exact: true }),
  );
  await screen.findByRole("heading", { name: "Existing work" });
  await user.type(
    screen.getByRole("textbox", { name: "Follow-up instruction" }),
    "Keep my draft",
  );
  await user.click(
    screen.getByRole("button", { name: "Close tab: Two — /two" }),
  );
  expect(screen.getByRole("heading", { name: "Existing work" })).toBeTruthy();
  await user.click(
    screen.getByRole("button", { name: "Close tab: One — /one" }),
  );
  expect(screen.getByRole("heading", { name: "Your workspace" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open One — /one" })).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "One — /one", exact: true }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: /^Close tab:/ })).toBeNull();
  expect(JSON.parse(localStorage.getItem("fleet.closed-project-tabs"))).toEqual(
    ["two", "one"],
  );
  first.unmount();
  render(<App />);
  await screen.findByRole("heading", { name: "Your workspace" });
  expect(
    screen.queryByRole("button", { name: "One — /one", exact: true }),
  ).toBeNull();
  await user.click(screen.getByLabelText("Open project tab"));
  await user.click(
    screen.getByRole("button", { name: "Open tab: One — /one" }),
  );
  await screen.findByRole("heading", { name: "Existing work" });
  expect(
    screen.getByRole("textbox", { name: "Follow-up instruction" }).value,
  ).toBe("Keep my draft");
  expect(
    screen
      .getByRole("button", { name: "One — /one", exact: true })
      .getAttribute("aria-current"),
  ).toBe("page");
  await user.click(screen.getByLabelText("Open project tab"));
  await user.click(
    screen.getByRole("button", { name: "New project…", exact: true }),
  );
  expect(screen.getByLabelText(/^Parent folder/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Cancel", exact: true }));
  await user.click(screen.getByLabelText("Open project tab"));
  await user.click(
    screen.getByRole("button", { name: "Open folder…", exact: true }),
  );
  expect(screen.getByLabelText(/^Folder path/)).toBeTruthy();
  expect(
    request.mock.calls.some(
      ([, options]) => options?.method && options.method !== "GET",
    ),
  ).toBe(false);
  expect(state.projects).toHaveLength(2);
  expect(state.runs).toEqual([run]);
});
test("Home shows real project paths and activity, filters projects and keeps scratch and examples separate", async () => {
  const user = userEvent.setup(),
    open = vi.fn(),
    resume = vi.fn();
  render(
    <HomePage
      state={{
        ...emptyState,
        projects: [
          {
            id: "a",
            name: "Alpha",
            path: "/work/alpha",
            createdAt: "2026-09-01T12:00:00Z",
          },
          { id: "b", name: "Beta", path: "/work/beta" },
          { id: "s", name: "Scratch", kind: "scratch" },
          { id: "x", name: "Hidden example", example: true },
        ],
        runs: [
          {
            id: "last",
            projectId: "a",
            title: "Real work",
            updatedAt: "2026-09-06T09:00:00Z",
          },
          {
            id: "scratch",
            projectId: "s",
            title: "Scratch thought",
            createdAt: "2026-09-05T09:00:00Z",
          },
          {
            id: "reviewer",
            projectId: "a",
            teamRole: "security",
            title: "Reviewer",
            updatedAt: "2026-09-06T10:00:00Z",
          },
        ],
      }}
      selected="deleted-session"
      onProject={open}
      onContinue={resume}
      onNew={() => {}}
      onOpen={() => {}}
      onScratch={() => {}}
    />,
  );
  expect(screen.getByText("/work/alpha")).toBeTruthy();
  expect(screen.queryByText("Hidden example")).toBeNull();
  await user.click(
    screen.getByRole("button", { name: /Continue working: Real work/ }),
  );
  expect(resume).toHaveBeenCalledWith("last");
  await user.type(
    screen.getByRole("textbox", { name: "Find a project" }),
    "beta",
  );
  expect(screen.queryByRole("button", { name: /^Open Alpha/ })).toBeNull();
  await user.click(screen.getByRole("button", { name: /^Open Beta/ }));
  expect(open).toHaveBeenCalledWith("b");
  await user.click(screen.getByText("Scratch conversations (1)"));
  await user.click(screen.getByRole("button", { name: "Scratch thought" }));
  expect(resume).toHaveBeenCalledWith("scratch");
});
test("Home distinguishes duplicate project names by folder without renaming records", async () => {
  const user = userEvent.setup(),
    open = vi.fn();
  const projects = [
    { id: "a", name: "test", path: "/work/alpha/" },
    { id: "b", name: "test", sourcePath: "/work/beta", path: "/internal/copy" },
  ];
  render(<HomePage state={{ ...emptyState, projects }} onProject={open} />);
  const alpha = screen.getByRole("button", {
    name: "Open test — /work/alpha/",
  });
  const beta = screen.getByRole("button", { name: "Open test — /work/beta" });
  expect(within(alpha).getByText("alpha")).toBeTruthy();
  expect(within(beta).getByText("beta")).toBeTruthy();
  const tone = beta.getAttribute("data-tone");
  await user.type(
    screen.getByRole("textbox", { name: "Find a project" }),
    " beta ",
  );
  expect(
    screen.queryByRole("button", { name: /Open test — \/work\/alpha/ }),
  ).toBeNull();
  expect(
    screen
      .getByRole("button", { name: /Open test — \/work\/beta/ })
      .getAttribute("data-tone"),
  ).toBe(tone);
  await user.click(
    screen.getByRole("button", { name: /Open test — \/work\/beta/ }),
  );
  expect(open).toHaveBeenCalledWith("b");
  await user.click(
    screen.getByRole("button", { name: "Clear project search" }),
  );
  expect(screen.getByText("alpha")).toBeTruthy();
  expect(projects.map((p) => p.name)).toEqual(["test", "test"]);
});
test("Home recent work excludes empty drafts and team placeholders and ignores reviewer activity for ordering", () => {
  const projects = [
    { id: "older", name: "Older", createdAt: "2026-09-01T12:00:00Z" },
    { id: "newer", name: "Newer", createdAt: "2026-09-02T12:00:00Z" },
  ];
  const runs = [
    {
      id: "legacy",
      projectId: "older",
      title: "Developer",
      teamRole: "developer",
      updatedAt: "2026-09-06T12:00:00Z",
    },
    {
      id: "draft",
      projectId: "older",
      title: "New conversation",
      waitingForTask: true,
      updatedAt: "2026-09-06T12:00:00Z",
    },
    {
      id: "review",
      projectId: "older",
      title: "Security",
      teamRole: "security",
      updatedAt: "2026-09-06T12:00:00Z",
    },
  ];
  render(
    <HomePage state={{ ...emptyState, projects, runs }} selected="legacy" />,
  );
  expect(
    screen.queryByRole("region", { name: "Recent conversations" }),
  ).toBeNull();
  expect(
    within(screen.getByRole("region", { name: "Your projects" }))
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label")),
  ).toEqual(["Open Newer — project", "Open Older — project"]);
});
test("Home features the remembered conversation and bounds other recent threads without duplication", async () => {
  const user = userEvent.setup(),
    resume = vi.fn();
  const runs = Array.from({ length: 5 }, (_, i) => ({
    id: `r${i}`,
    projectId: "p",
    title: `Task ${i}`,
    createdAt: `2026-09-0${i + 1}T12:00:00Z`,
  }));
  render(
    <HomePage
      state={{ ...emptyState, projects: [{ id: "p", name: "Project" }], runs }}
      selected="r0"
      onContinue={resume}
    />,
  );
  const buttons = within(
    screen.getByRole("region", { name: "Recent conversations" }),
  ).getAllByRole("button");
  expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
    "Continue working: Task 4",
    "Continue working: Task 3",
    "Continue working: Task 2",
    "Continue working: Task 1",
  ]);
  await user.click(
    within(screen.getByRole("region", { name: "Continue working" })).getByRole(
      "button",
    ),
  );
  expect(resume).toHaveBeenCalledWith("r0");
});
test("Home attention uses real unresolved findings and failed or completed tasks, never empty reviewer successes", async () => {
  const go = vi.fn(),
    user = userEvent.setup();
  const runs = [
    {
      id: "coding",
      projectId: "p",
      title: "Implement notes",
      status: "review",
      summary: "Added note editing",
      updatedAt: "2026-09-06",
    },
    {
      id: "failed",
      projectId: "p",
      title: "Check routes",
      teamRole: "verification",
      status: "failed",
    },
    {
      id: "security",
      projectId: "p",
      title: "Security report",
      teamRole: "security",
      status: "review",
    },
    {
      id: "quiet",
      projectId: "p",
      title: "Passed reviewer",
      teamRole: "verification",
      status: "review",
    },
    {
      id: "deleted",
      projectId: "p",
      title: "Deleted run",
      status: "failed",
      deletedAt: "2026-09-06",
    },
    {
      id: "example",
      projectId: "hidden",
      title: "Hidden failure",
      status: "failed",
    },
    {
      id: "terminal",
      projectId: "p",
      title: "Terminal",
      sessionKind: "terminal",
      status: "draft",
    },
  ];
  const state = {
    ...emptyState,
    projects: [
      { id: "p", name: "Notes", path: "/notes" },
      { id: "hidden", name: "Hidden", example: true },
    ],
    runs,
    findings: [
      { id: "f1", runId: "security", state: "suspected" },
      { id: "f2", runId: "security", state: "resolved" },
      { id: "f3", runId: "missing", state: "suspected" },
    ],
  };
  render(<HomePage state={state} onContinue={go} />);
  const attention = screen.getByRole("complementary", {
    name: "Needs your attention",
  });
  expect(
    within(attention)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label")),
  ).toEqual([
    "1 security finding: Security report",
    "Run failed: Check routes",
    "Ready to review: Implement notes",
  ]);
  await user.click(
    within(attention).getByRole("button", { name: /1 security finding/ }),
  );
  expect(go).toHaveBeenCalledExactlyOnceWith("security");
  expect(screen.queryByText("Passed reviewer")).toBeNull();
  expect(screen.queryByText("Deleted run")).toBeNull();
  expect(screen.queryByText("Hidden failure")).toBeNull();
  expect(screen.getByText("Added note editing")).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Your projects" })).getByText(
      "1 chat",
    ),
  ).toBeTruthy();
});
test("Home omits an empty attention panel and terminal entries without pretending work is ready", () => {
  render(
    <HomePage
      state={{
        ...emptyState,
        projects: [{ id: "p", name: "Project" }],
        runs: [
          {
            id: "t",
            projectId: "p",
            title: "Terminal",
            sessionKind: "terminal",
            status: "draft",
          },
          {
            id: "r",
            projectId: "p",
            title: "Reviewer",
            teamRole: "security",
            status: "review",
          },
        ],
      }}
    />,
  );
  expect(
    screen.queryByRole("complementary", { name: "Needs your attention" }),
  ).toBeNull();
  expect(screen.queryByRole("region", { name: "Continue working" })).toBeNull();
  expect(
    screen.queryByRole("region", { name: "Recent conversations" }),
  ).toBeNull();
  expect(screen.getByText("0 chats")).toBeTruthy();
});
test("Home has useful empty and no-match states and respects busy start actions", async () => {
  const user = userEvent.setup(),
    open = vi.fn(),
    scratch = vi.fn();
  const props = { state: emptyState, onOpen: open, onScratch: scratch };
  const view = render(<HomePage {...props} busy />);
  expect(screen.getByText("Your next project starts here")).toBeTruthy();
  for (const name of [
    "New project",
    "Open folder",
    "Start without a project",
    "Choose a folder",
  ]) {
    expect(screen.getByRole("button", { name }).disabled).toBe(true);
  }
  view.rerender(<HomePage {...props} />);
  await user.click(screen.getByRole("button", { name: "Choose a folder" }));
  expect(open).toHaveBeenCalledOnce();
  await user.click(
    screen.getByRole("button", { name: "Start without a project" }),
  );
  expect(scratch).toHaveBeenCalledOnce();
  view.rerender(
    <HomePage
      {...props}
      state={{ ...emptyState, projects: [{ id: "p", name: "Alpha" }] }}
    />,
  );
  await user.type(
    screen.getByRole("textbox", { name: "Find a project" }),
    "missing",
  );
  expect(screen.getByText("No matching projects")).toBeTruthy();
  await user.click(
    screen.getByRole("button", { name: "Clear search", exact: true }),
  );
  expect(screen.getByText("Alpha")).toBeTruthy();
});
test("Home New project and Open folder select the correct setup mode without creating anything", async () => {
  const user = userEvent.setup();
  const request = vi.fn(async () => ({
    ok: true,
    json: async () => emptyState,
  }));
  vi.stubGlobal("fetch", request);
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "New project", exact: true }),
  );
  expect(screen.getByLabelText(/Parent folder/)).toBeTruthy();
  expect(screen.getByLabelText(/Folder name/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(
    screen.getByRole("button", { name: "Open folder", exact: true }),
  );
  expect(screen.getByLabelText(/Folder path/)).toBeTruthy();
  expect(screen.queryByLabelText(/Parent folder/)).toBeNull();
  expect(request.mock.calls.every(([url]) => url === "/api/state")).toBe(true);
});
test("an explicit session deep link bypasses Home without queueing the session", async () => {
  const run = {
    id: "linked",
    projectId: "p",
    title: "Linked conversation",
    prompt: "Task",
    status: "review",
    sandbox: "read-only",
    scopes: [],
    files: [],
    dependencies: [],
    usage: {},
    createdAt: "2026-09-06T09:00:00Z",
  };
  const request = vi.fn(async (url) => ({
    ok: true,
    json: async () =>
      url === "/api/state"
        ? {
            ...emptyState,
            projects: [{ id: "p", name: "Project" }],
            runs: [run],
          }
        : { ...run, events: [] },
  }));
  vi.stubGlobal("fetch", request);
  history.replaceState(null, "", "/#session=linked");
  try {
    render(<App />);
    await screen.findByRole("heading", { name: run.title });
    expect(
      screen.queryByRole("heading", { name: "Your workspace" }),
    ).toBeNull();
    expect(
      request.mock.calls.some(([, options]) => options?.method === "POST"),
    ).toBe(false);
  } finally {
    history.replaceState(null, "", "/");
  }
});
test("sidebar main chat opens idle after choosing its kind, without duplicate requests", async () => {
  const user = userEvent.setup();
  const project = {
    id: "direct",
    name: "Direct project",
    path: "/direct",
    branch: "main",
  };
  const run = {
    id: "direct-run",
    projectId: project.id,
    title: "New conversation",
    waitingForTask: true,
    status: "draft",
    sandbox: "read-only",
    scopes: [],
    files: [],
    dependencies: [],
    usage: {},
    createdAt: new Date().toISOString(),
  };
  let runs = [],
    finishOpening;
  const request = vi.fn(async (url) => {
    if (url === "/api/sessions/new") {
      await new Promise((resolve) => {
        finishOpening = resolve;
      });
      runs = [run];
      return { ok: true, json: async () => run };
    }
    return {
      ok: true,
      json: async () =>
        url === "/api/state"
          ? { ...emptyState, projects: [project], runs }
          : { ...run, events: [] },
    };
  });
  vi.stubGlobal("fetch", request);
  const { container } = render(<App />);
  await user.click(
    await screen.findByRole("button", { name: /^Open Direct project/ }),
  );
  const plus = await screen.findByRole("button", {
    name: "New item in Direct project",
  });
  await user.click(plus);
  expect(request.mock.calls.some(([url]) => url === "/api/sessions/new")).toBe(
    false,
  );
  await user.dblClick(screen.getByRole("button", { name: /^New main chat/ }));
  expect(
    request.mock.calls.filter(([url]) => url === "/api/sessions/new"),
  ).toHaveLength(1);
  finishOpening();
  await screen.findByRole("heading", { name: "What are we working on?" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(container.querySelector(".rail")).toBeNull();
  expect(container.querySelector(".detail-tabs")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Follow-up instruction" })).toBe(
    document.activeElement,
  );
  expect(screen.getByRole("button", { name: "Read only" })).toBeTruthy();
  expect(request.mock.calls.some(([url]) => url.endsWith("/start"))).toBe(
    false,
  );
  const body = JSON.parse(
    request.mock.calls.find(([url]) => url === "/api/sessions/new")[1].body,
  );
  expect(body).toMatchObject({
    projectId: project.id,
    kind: "main",
    approved: true,
  });
  await user.click(container.querySelector(".project-menu > summary"));
  await user.click(
    screen.getByRole("button", { name: "Activity & attention" }),
  );
  expect(
    screen.getByRole("region", { name: "Projects and sessions" }),
  ).toBeTruthy();
});
test("conversation permissions are saved explicitly without submitting an instruction", async () => {
  const user = userEvent.setup(),
    close = vi.fn();
  const request = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      models: [{ model: "installed-model", displayName: "Installed model" }],
    }),
  }));
  vi.stubGlobal("fetch", request);
  render(
    <SessionOptions
      run={{ id: "options", sandbox: "read-only" }}
      act={(fn) => fn()}
      onClose={close}
    />,
  );
  await user.selectOptions(
    screen.getByLabelText("Permissions"),
    "workspace-write",
  );
  await user.click(
    screen.getByRole("checkbox", {
      name: /Use these settings for new conversations/,
    }),
  );
  expect(
    request.mock.calls.some(([, options]) => options?.method === "POST"),
  ).toBe(false);
  await user.click(screen.getByRole("button", { name: "Apply settings" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  const mutation = request.mock.calls.find(([url]) => url.endsWith("/options"));
  expect(JSON.parse(mutation[1].body)).toEqual({
    sandbox: "workspace-write",
    model: "",
    rememberDefaults: true,
    approved: true,
  });
  expect(request.mock.calls.some(([url]) => url.endsWith("/start"))).toBe(
    false,
  );
});
test("quiet reviewers show findings and failures but hide routine progress", () => {
  const props = {
    quiet: true,
    projectId: "one",
    runId: "task",
    goRun: () => {},
    onSettings: () => {},
  };
  const state = {
    runs: [],
    teams: [
      {
        projectId: "one",
        enabled: true,
        maxRounds: 5,
        roundsUsed: 1,
        members: {},
      },
    ],
    teamRounds: [{ targetRunId: "task", status: "completed", reports: {} }],
  };
  const { container, rerender } = render(
    <TeamBadge {...props} state={state} />,
  );
  expect(container.textContent).toBe("");
  rerender(
    <TeamBadge
      {...props}
      state={{
        ...state,
        teamRounds: [{ targetRunId: "task", status: "failed" }],
      }}
    />,
  );
  expect(screen.getByText("Review needs attention")).toBeTruthy();
});
test("reviewer badge stays collapsed and reports the latest round, not an older clean review", async () => {
  const user = userEvent.setup(),
    goRun = vi.fn();
  const { container } = render(
    <TeamBadge
      projectId="one"
      runId="task"
      goRun={goRun}
      onSettings={() => {}}
      state={{
        runs: [{ id: "security", status: "review", teamRole: "security" }],
        teams: [
          {
            projectId: "one",
            enabled: true,
            maxRounds: 5,
            roundsUsed: 2,
            members: { security: "security" },
          },
        ],
        teamRounds: [
          { targetRunId: "task", status: "failed" },
          { targetRunId: "task", status: "completed" },
        ],
      }}
    />,
  );
  expect(container.querySelector("details").open).toBe(false);
  await user.click(screen.getByText("Review needs attention"));
  expect(container.querySelector("details").open).toBe(true);
  await user.click(screen.getByRole("button", { name: /security/ }));
  expect(goRun).toHaveBeenCalledWith("security");
});
test("quick session opens a blank scratch conversation with explicit read-only defaults", async () => {
  const user = userEvent.setup(),
    created = vi.fn();
  const request = vi.fn(async () => ({
    ok: true,
    json: async () => ({ id: "blank", projectId: "scratch" }),
  }));
  vi.stubGlobal("fetch", request);
  render(
    <QuickSession
      state={emptyState}
      onClose={() => {}}
      onCreated={created}
      onAdd={() => {}}
      onGuided={() => {}}
      act={(fn) => fn()}
    />,
  );
  expect(
    screen
      .getByRole("button", { name: "Read only" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(request).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Open conversation" }));
  await waitFor(() =>
    expect(created).toHaveBeenCalledWith({ id: "blank", projectId: "scratch" }),
  );
  expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({
    approved: true,
    prompt: "",
    sandbox: "read-only",
    projectId: null,
    rememberDefaults: false,
  });
});
test("quick session loads project defaults, retains unsent instructions and explicitly saves changed settings", async () => {
  const user = userEvent.setup();
  const state = {
    ...emptyState,
    projects: [
      {
        id: "one",
        name: "One",
        path: "/one",
        sessionDefaults: { sandbox: "workspace-write", model: "saved-model" },
      },
      { id: "two", name: "Two", path: "/two" },
    ],
  };
  const request = vi.fn(async () => ({
    ok: true,
    json: async () => ({ id: "created" }),
  }));
  vi.stubGlobal("fetch", request);
  const props = {
    state,
    projectId: "one",
    onClose: () => {},
    onCreated: () => {},
    onAdd: () => {},
    onGuided: () => {},
    act: (fn) => fn(),
  };
  const first = render(<QuickSession {...props} />);
  expect(
    screen
      .getByRole("button", { name: "Allow edits" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  await user.type(screen.getByLabelText(/^Instruction/), "Keep this task");
  first.unmount();
  render(<QuickSession {...props} />);
  expect(screen.getByLabelText(/^Instruction/).value).toBe("Keep this task");
  await user.click(screen.getByText("Session options"));
  expect(screen.getByLabelText(/^Model/).value).toBe("saved-model");
  await user.click(
    screen.getByRole("checkbox", { name: /Remember these settings/ }),
  );
  await user.click(screen.getByRole("button", { name: "Start session" }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({
    prompt: "Keep this task",
    projectId: "one",
    model: "saved-model",
    sandbox: "workspace-write",
    rememberDefaults: true,
  });
  expect(localStorage.getItem("fleet.quick.one")).toBeNull();
});
test("new workspace menu offers all three actions, dismisses and keeps the group project", async () => {
  const user = userEvent.setup(),
    onNew = vi.fn();
  const view = render(
    <NewWorkspaceMenu
      compact
      project={{ id: "two", name: "Two" }}
      onNew={onNew}
    />,
  );
  const plus = screen.getByRole("button", { name: "New item in Two" });
  await user.click(plus);
  expect(screen.getByRole("button", { name: /^New Git worktree/ })).toBe(
    document.activeElement,
  );
  expect(screen.getAllByRole("button")).toHaveLength(4);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("group")).toBeNull();
  expect(document.activeElement).toBe(plus);
  for (const [label, kind] of [
    ["New Git worktree", "worktree"],
    ["New main chat", "main"],
    ["New terminal", "terminal"],
  ]) {
    await user.click(plus);
    await user.click(
      screen.getByRole("button", { name: new RegExp(`^${label}`) }),
    );
    expect(onNew).toHaveBeenLastCalledWith("two", kind);
    expect(screen.queryByRole("group")).toBeNull();
  }
  await user.click(plus);
  await user.click(document.body);
  expect(screen.queryByRole("group")).toBeNull();
  expect(onNew).toHaveBeenCalledTimes(3);
  view.rerender(
    <NewWorkspaceMenu
      compact
      project={{ id: "two", name: "Two" }}
      busy
      onNew={onNew}
    />,
  );
  expect(plus.disabled).toBe(true);
});

test("sidebar terminal selection immediately opens only a shell, without intro text or Codex", async () => {
  const user = userEvent.setup();
  const project = {
    id: "shell-project",
    name: "Shell project",
    path: "/shell-project",
  };
  const run = {
    id: "shell-run",
    projectId: project.id,
    title: "Terminal",
    sessionKind: "terminal",
    workspaceKind: "main",
    worktree: project.path,
    status: "draft",
    waitingForTask: true,
    files: [],
  };
  let runs = [];
  const request = vi.fn(async (url) => {
    if (url === "/api/sessions/new") runs = [run];
    if (url.endsWith("/terminal/open"))
      return { ok: true, json: async () => ({ lease: "test-lease" }) };
    if (url.includes("/terminal?"))
      return { ok: true, json: async () => ({ events: [] }) };
    return {
      ok: true,
      json: async () =>
        url === "/api/state"
          ? { ...emptyState, projects: [project], runs }
          : run,
    };
  });
  vi.stubGlobal("fetch", request);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: /^Open Shell project/ }),
  );
  await user.click(
    screen.getByRole("button", { name: "New item in Shell project" }),
  );
  await user.click(screen.getByRole("button", { name: /^New terminal/ }));
  expect(
    await screen.findByRole("button", { name: "Close terminal" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("textbox", { name: "Follow-up instruction" }),
  ).toBeNull();
  expect(
    screen.queryByText(/Commands can change your original project files/),
  ).toBeNull();
  expect(screen.queryByRole("heading", { name: "Terminal" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Open project shell" }),
  ).toBeNull();
  expect(
    request.mock.calls.filter(([url]) => url.endsWith("/terminal/open")),
  ).toHaveLength(1);
  expect(request.mock.calls.some(([url]) => url.endsWith("/start"))).toBe(
    false,
  );
  await user.click(screen.getByRole("button", { name: "Close terminal" }));
  expect(
    await screen.findByRole("button", { name: "Reopen terminal" }),
  ).toBeTruthy();
  expect(
    request.mock.calls.filter(([url]) => url.endsWith("/terminal/open")),
  ).toHaveLength(1);
});

test("direct terminal opens once in StrictMode and failed opens require an explicit retry", async () => {
  const user = userEvent.setup();
  const request = vi.fn(async () => ({
    ok: false,
    status: 409,
    json: async () => ({
      error: "This shell is controlled by another client.",
    }),
  }));
  vi.stubGlobal("fetch", request);
  const act = async (fn) => {
    try {
      return await fn();
    } catch {
      return null;
    }
  };
  render(
    <React.StrictMode>
      <TerminalView
        standalone
        run={{ id: "locked", workspaceKind: "main" }}
        act={act}
      />
    </React.StrictMode>,
  );
  expect(
    await screen.findByText("This shell is controlled by another client."),
  ).toBeTruthy();
  expect(request).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(request).toHaveBeenCalledTimes(2);
});

test("project sidebar only shows the selected project without reviewer duplicates or navigation on collapse", async () => {
  const user = userEvent.setup(),
    goRun = vi.fn(),
    choose = vi.fn();
  render(
    <WorkspaceSidebar
      state={{
        ...emptyState,
        projects: [
          { id: "one", name: "One" },
          { id: "two", name: "Two" },
          { id: "scratch", name: "Scratch", kind: "scratch" },
        ],
        runs: [
          { id: "a", projectId: "one", title: "First task", status: "draft" },
          { id: "b", projectId: "two", title: "Second task", status: "review" },
          {
            id: "c",
            projectId: "two",
            title: "Security member",
            teamRole: "security",
            status: "draft",
          },
          {
            id: "d",
            projectId: "scratch",
            title: "Scratch thought",
            status: "draft",
          },
        ],
      }}
      projectId="one"
      selected="a"
      goRun={goRun}
      chooseProject={choose}
      onNew={() => {}}
      onAdd={() => {}}
    />,
  );
  expect(screen.queryByText("Second task")).toBeNull();
  expect(screen.queryByText("Scratch thought")).toBeNull();
  expect(screen.queryByText("Security member")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Collapse One" }));
  expect(choose).not.toHaveBeenCalled();
  expect(screen.queryByText("First task")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Expand One" }));
  await user.click(screen.getByText("First task"));
  expect(goRun).toHaveBeenCalledWith("a");
});
test("files open alongside the conversation and first instructions are not duplicated", async () => {
  const user = userEvent.setup();
  const run = {
    id: "workspace",
    projectId: "one",
    title: "Workspace test",
    prompt: "My first instruction",
    initialPrompt: "My first instruction",
    status: "review",
    sandbox: "read-only",
    worktree: "/fixture",
    createdAt: new Date().toISOString(),
    scopes: [],
    files: [],
    dependencies: [],
    usage: {},
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => ({
      ok: true,
      json: async () =>
        url.includes("/files?")
          ? { content: "// actual file content" }
          : url.endsWith("/files")
            ? { files: ["app.js"] }
            : {
                ...run,
                events: [
                  {
                    seq: 1,
                    type: "run.queued",
                    time: run.createdAt,
                    data: { prompt: run.prompt, initialInstruction: true },
                  },
                ],
              },
    })),
  );
  render(
    <RunDetail
      runId={run.id}
      project={{ id: "one" }}
      state={{ runs: [run], findings: [] }}
      act={(fn) => fn()}
      goRun={() => {}}
      onSettings={() => {}}
    />,
  );
  await screen.findByRole("heading", { name: "Workspace test" });
  await user.click(screen.getByText("Tools", { selector: "summary" }));
  await user.click(screen.getByRole("button", { name: "Files", exact: true }));
  await user.click(await screen.findByRole("button", { name: "app.js" }));
  expect(await screen.findByText("// actual file content")).toBeTruthy();
  expect(screen.getAllByText("My first instruction")).toHaveLength(1);
  expect(
    screen.getByRole("region", { name: "Codex conversation" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("textbox", { name: "Follow-up instruction" }),
  ).toBeTruthy();
  expect(localStorage.getItem("fleet.tool.workspace")).toBe("files");
});
test("idea-first setup keeps advanced controls collapsed and explicitly queues the first task", async () => {
  const save = vi.fn(),
    user = userEvent.setup();
  const { container } = render(
    <ProjectStart onSave={save} onClose={() => {}} />,
  );
  await user.type(
    screen.getByLabelText(/Your idea/),
    "Build a feedback tracker",
  );
  expect(screen.queryByLabelText(/Parent folder/)).toBeNull();
  await user.click(screen.getByRole("button", { name: "Choose folder" }));
  expect(container.querySelector("details.project-advanced").open).toBe(false);
  await user.type(screen.getByLabelText(/Parent folder/), "/test/projects");
  await user.type(screen.getByLabelText(/Folder name/), "feedback");
  await user.click(
    screen.getByRole("checkbox", { name: /Initialise local Git/ }),
  );
  await user.click(screen.getByRole("button", { name: "Create & build" }));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      firstTask: {
        approved: true,
        prompt: expect.stringContaining("Build a feedback tracker"),
      },
    }),
  );
});
test("snapshot selection blocks excluded files and invalidates approval after selection changes", async () => {
  const change = vi.fn(),
    user = userEvent.setup();
  render(
    <SnapshotSelection
      snapshot={{
        files: [
          { path: "app.js" },
          { path: ".env", excluded: "Sensitive filename" },
        ],
        selected: ["app.js"],
        approved: true,
      }}
      onChange={change}
    />,
  );
  expect(screen.getByRole("checkbox", { name: /.env/ }).disabled).toBe(true);
  await user.click(screen.getByRole("checkbox", { name: "app.js" }));
  expect(change).toHaveBeenCalledWith(
    expect.objectContaining({ approved: false, selected: [] }),
  );
});
test("preview requires execution consent and hands output back as an unsent draft", async () => {
  const user = userEvent.setup(),
    evidence = vi.fn(),
    act = vi.fn((fn) => fn());
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
  vi.stubGlobal("fetch", fetchMock);
  const run = {
    id: "preview",
    worktree: "/test/worktree",
    preview: {
      status: "exited",
      command: "npm run dev",
      port: 4400,
      output: "Server failed",
      exitCode: 1,
    },
  };
  render(<Preview run={run} act={act} onEvidence={evidence} />);
  await user.click(screen.getByRole("button", { name: "Start preview" }));
  expect(act).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("checkbox", { name: /Run this command as my local user/ }),
  );
  await user.click(screen.getByRole("button", { name: "Start preview" }));
  await waitFor(() => expect(act).toHaveBeenCalledTimes(1));
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).approved).toBe(true);
  await user.click(screen.getByText("Server output"));
  await user.click(
    screen.getByRole("button", { name: "Draft a fix from output" }),
  );
  expect(evidence).toHaveBeenCalledWith(
    expect.stringContaining("untrusted evidence"),
  );
  expect(act).toHaveBeenCalledTimes(1);
});
test("team setup needs explicit approval and sends the chosen budget", async () => {
  const user = userEvent.setup(),
    act = vi.fn((fn) => fn());
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ id: "project", enabled: true }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  render(
    <TeamSettings
      project={{ id: "project" }}
      state={{
        teams: [],
        teamConfig: {
          defaults: {
            roles: ["developer", "security", "verification"],
            maxRounds: 5,
            timeoutMinutes: 5,
          },
        },
      }}
      act={act}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Enable project team" }).disabled,
  ).toBe(true);
  await user.click(
    screen.getByRole("checkbox", { name: "Include Memory proposals" }),
  );
  await user.click(
    screen.getByRole("checkbox", {
      name: "Approve these sessions, read-only reviews and this bounded budget",
    }),
  );
  await user.click(screen.getByRole("button", { name: "Enable project team" }));
  const [url, options] = fetchMock.mock.calls[0];
  expect(url).toBe("/api/projects/project/team");
  expect(JSON.parse(options.body)).toMatchObject({
    approved: true,
    maxRounds: 5,
    roles: ["developer", "security", "verification", "memory"],
  });
});
test("team review renders evidence and requires a reason to acknowledge findings", async () => {
  const user = userEvent.setup();
  const run = { id: "lead", status: "review", sandbox: "workspace-write" };
  render(
    <TeamReviews
      project={{ id: "project" }}
      run={run}
      state={{
        teams: [
          {
            projectId: "project",
            enabled: true,
            members: { security: "reviewer" },
          },
        ],
        teamRounds: [
          {
            id: "round",
            targetRunId: "lead",
            snapshot: "abcdef12345",
            kind: "changes",
            status: "completed",
            roles: ["security"],
            reports: {
              security: {
                status: "complete",
                summary: "Review result",
                coverage: "Authentication handlers",
                findings: [
                  {
                    title: "Missing ownership check",
                    file: "src/api.js",
                    line: 12,
                    severity: "high",
                    confidence: "medium",
                    evidence: "Request owner is not checked.",
                    verification: "Test a request from another account.",
                  },
                ],
                memory: "",
              },
            },
          },
        ],
      }}
      act={() => {}}
      goRun={() => {}}
    />,
  );
  expect(screen.getByText("Missing ownership check")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Acknowledge findings" }).disabled,
  ).toBe(true);
  await user.type(
    screen.getByRole("textbox", {
      name: "Reason for acknowledging team findings",
    }),
    "Verified route middleware.",
  );
  expect(
    screen.getByRole("button", { name: "Acknowledge findings" }).disabled,
  ).toBe(false);
});
test("onboarding hides preserved examples and offers only real repository setup", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ...emptyState,
        projects: [{ id: "example", name: "Fieldnotes", example: true }],
      }),
    })),
  );
  render(<App />);
  expect(
    await screen.findByRole("heading", { name: "Your workspace" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Explore an example" }),
  ).toBeNull();
  expect(screen.queryByRole("option", { name: "Fieldnotes" })).toBeNull();
});
test("new session uses model names returned by Codex discovery", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        models: [{ model: "server-model", displayName: "Actual server model" }],
      }),
    })),
  );
  const user = userEvent.setup();
  render(
    <RunDialog
      project={{ id: "real", name: "Real" }}
      onSave={() => {}}
      onClose={() => {}}
    />,
  );
  await user.click(screen.getByText("Context & model"));
  expect(
    await screen.findByRole("option", { name: "Actual server model" }),
  ).toBeTruthy();
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Model" }),
    "server-model",
  );
  expect(screen.getByRole("combobox", { name: "Model" }).value).toBe(
    "server-model",
  );
});
test("workflow editor renders daemon templates and concurrency instead of frontend defaults", async () => {
  const user = userEvent.setup();
  render(
    <WorkflowPlanner
      project={{ id: "real" }}
      state={{
        workflows: [],
        limits: { tasks: 2, concurrency: 1, attempts: 1 },
        workflowTemplates: [
          {
            id: "from-server",
            title: "Server template",
            tasks: [{ title: "Server task", prompt: "Actual instruction" }],
          },
        ],
      }}
      act={() => {}}
      goRun={() => {}}
    />,
  );
  expect(
    screen.getByText("Up to 2 tasks · 1 parallel · 0 corrective retry"),
  ).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Plan a workflow" }));
  expect(screen.getByRole("option", { name: "Server template" })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Instruction" }).value).toBe(
    "Actual instruction",
  );
});
test("repository inspection offers a detected check command without saving or running it", async () => {
  const onSave = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        name: "Real",
        branch: "main",
        dirty: true,
        commands: [{ command: "pnpm test" }],
      }),
    })),
  );
  const user = userEvent.setup();
  render(<ProjectDialog onSave={onSave} onClose={() => {}} />);
  await user.type(
    screen.getByRole("textbox", { name: /Folder path/ }),
    "/test/real",
  );
  await user.click(screen.getByRole("button", { name: "Check folder" }));
  await user.click(
    await screen.findByRole("button", { name: "Use pnpm test" }),
  );
  expect(
    screen.getByRole("textbox", { name: /Validation command/ }).value,
  ).toBe("pnpm test");
  expect(onSave).not.toHaveBeenCalled();
});
test("new project teams open on the developer, not an idle reviewer", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ...emptyState,
        projects: [{ id: "fresh", name: "Fresh", branch: "main" }],
        runs: ["verification", "security", "developer"].map((role) => ({
          id: role,
          projectId: "fresh",
          teamRole: role,
          title: role,
          status: "draft",
          sandbox: "read-only",
          prompt: "Assess project",
          files: [],
          scopes: [],
          dependencies: [],
        })),
      }),
    })),
  );
  render(<App />);
  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: /^Open Fresh/ }));
  expect(
    await screen.findByRole("heading", { name: "developer" }),
  ).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "verification" })).toBeNull();
});
test("new projects require Git approval and submit a parent plus folder name", async () => {
  const onSave = vi.fn(),
    user = userEvent.setup();
  render(<ProjectDialog onSave={onSave} onClose={() => {}} />);
  await user.click(screen.getByRole("button", { name: "Create new project" }));
  await user.type(screen.getByLabelText(/Parent folder/), "/test/projects");
  await user.type(screen.getByLabelText(/Folder name/), "fresh-app");
  await user.click(screen.getByRole("button", { name: "Create project" }));
  expect(onSave).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("checkbox", { name: /Initialise local Git/ }),
  );
  await user.click(screen.getByRole("button", { name: "Create project" }));
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      mode: "create",
      parentPath: "/test/projects",
      folderName: "fresh-app",
      gitApproved: true,
    }),
  );
});
test("non-Git folders need inspection and explicit initialisation approval", async () => {
  const onSave = vi.fn(),
    user = userEvent.setup();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        kind: "folder",
        path: "/test/existing",
        name: "existing",
        commands: [],
      }),
    })),
  );
  render(<ProjectDialog onSave={onSave} onClose={() => {}} />);
  await user.type(screen.getByLabelText(/Folder path/), "/test/existing");
  await user.click(screen.getByRole("button", { name: "Check folder first" }));
  expect(onSave).not.toHaveBeenCalled();
  expect(
    await screen.findByText(/Existing files and staged changes stay untouched/),
  ).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Open project" }));
  expect(onSave).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("checkbox", { name: /Initialise local Git/ }),
  );
  await user.click(screen.getByRole("button", { name: "Open project" }));
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      mode: "initialise",
      path: "/test/existing",
      gitApproved: true,
    }),
  );
  await user.type(screen.getByLabelText(/Folder path/), "-different");
  expect(
    screen.queryByRole("checkbox", { name: /Initialise local Git/ }),
  ).toBeNull();
});
test("existing projects open into implementation work and expose command output", async () => {
  const run = {
    id: "implementation",
    projectId: "project",
    title: "Add deletion",
    status: "review",
    sandbox: "workspace-write",
    prompt: "Add deletion and tests.",
    createdAt: "2026-09-05T12:00:00Z",
    files: [],
    scopes: [],
    dependencies: [],
    durationMs: 1000,
    usage: { input_tokens: 20, output_tokens: 10 },
    branch: "fleet/test",
    worktree: "/test/worktree",
  };
  const event = {
    seq: 1,
    type: "item.completed",
    time: run.createdAt,
    data: {
      item: {
        type: "command_execution",
        command: "node --test",
        exit_code: 0,
        aggregated_output: "4 tests passed",
      },
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => ({
      ok: true,
      json: async () =>
        url === "/api/state"
          ? {
              ...emptyState,
              projects: [{ id: "project", name: "Fixture", branch: "main" }],
              runs: [
                {
                  ...run,
                  id: "reviewer",
                  title: "Review deletion",
                  reviewOf: run.id,
                },
                run,
              ],
            }
          : { ...run, events: [event] },
    })),
  );
  const user = userEvent.setup();
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: /^Open Fixture/ }),
  );
  expect(
    await screen.findByRole("heading", { name: "Add deletion", exact: true }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("heading", { name: "No session selected" }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "1 command executed" }));
  await user.click(screen.getByText("node --test", { selector: "code" }));
  expect(screen.getByText("4 tests passed")).toBeTruthy();
});
test("first launch has usable repository onboarding and no fabricated activity", async () => {
  const fetch = vi.fn(async () => ({ ok: true, json: async () => emptyState }));
  vi.stubGlobal("fetch", fetch);
  render(<App />);
  expect(
    await screen.findByRole("heading", { name: "Your workspace" }),
  ).toBeTruthy();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Open folder" }));
  const dialog = screen.getByRole("dialog", {
    name: "Add a project",
  });
  expect(within(dialog).getByLabelText(/Folder path/)).toBeTruthy();
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(fetch.mock.calls.every(([url]) => url === "/api/state")).toBe(true);
});
test("session drafts survive closing and reopening the composer", async () => {
  const user = userEvent.setup(),
    props = {
      project: { id: "draft-project", name: "Fixture" },
      onClose: () => {},
      onSave: () => {},
    };
  const first = render(<RunDialog {...props} />);
  await user.type(
    screen.getByLabelText("Task"),
    "Keep this unfinished thought",
  );
  first.unmount();
  render(<RunDialog {...props} />);
  expect(screen.getByLabelText("Task").value).toBe(
    "Keep this unfinished thought",
  );
});
test("review uses a single header and keeps session metadata out of the conversation", async () => {
  const run = {
    id: "focused",
    title: "Focused change",
    prompt: "A task",
    projectId: "project",
    status: "review",
    sandbox: "workspace-write",
    createdAt: "2026-09-05T12:00:00Z",
    files: [],
    scopes: [],
    dependencies: [],
    durationMs: 1,
    usage: {},
    branch: "fleet/private-metadata",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => ({
      ok: true,
      json: async () =>
        url.endsWith("/diff")
          ? { files: [], diff: "" }
          : { ...run, events: [] },
    })),
  );
  const user = userEvent.setup();
  render(
    <RunDetail
      runId={run.id}
      project={{ id: "project", validation: "node --test" }}
      state={{ runs: [run], findings: [] }}
      act={(fn) => fn()}
      goRun={() => {}}
      onSettings={() => {}}
    />,
  );
  await screen.findByRole("heading", { name: "Focused change" });
  expect(screen.queryByText("fleet/private-metadata")).toBeNull();
  expect(screen.queryByRole("button", { name: "Accept changes" })).toBeNull();
  await user.click(screen.getByText("Tools", { selector: "summary" }));
  await user.click(screen.getByRole("button", { name: "Changes & checks" }));
  expect(screen.getByRole("heading", { name: "Validation" })).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "Security observations" }),
  ).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Security review" })).toBeNull();
  expect(screen.getByRole("button", { name: "Accept changes" })).toBeTruthy();
});
test("session form defaults to read-only and supports saving a scoped build draft", async () => {
  const save = vi.fn();
  const user = userEvent.setup();
  render(
    <RunDialog
      project={{ name: "Fixture" }}
      onClose={() => {}}
      onSave={save}
    />,
  );
  await user.type(screen.getByLabelText("Session title"), "Add pagination");
  await user.type(
    screen.getByLabelText("Task"),
    "Add cursor pagination and tests.",
  );
  await user.click(screen.getByRole("button", { name: /Build/ }));
  await user.click(screen.getByText("Context & model"));
  await user.type(
    screen.getByLabelText(/Declared scope/),
    "src/api, tests/api",
  );
  await user.click(screen.getByLabelText("Start when created"));
  await user.click(screen.getByRole("button", { name: "Save draft" }));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      sandbox: "workspace-write",
      scopes: ["src/api", "tests/api"],
      title: "Add pagination",
    }),
    false,
  );
});
test("mission form records sequential dependencies and task instructions", async () => {
  const save = vi.fn();
  const user = userEvent.setup();
  render(<MissionDialog onSave={save} onClose={() => {}} />);
  await user.type(screen.getByLabelText("Mission"), "Improve notes");
  for (let i = 1; i <= 2; i++) {
    await user.type(screen.getByLabelText(`Task ${i} title`), `Task ${i}`);
    await user.type(
      screen.getByLabelText(`Task ${i} instruction`),
      `Do part ${i}`,
    );
  }
  await user.selectOptions(screen.getByLabelText("Execution"), "sequential");
  await user.click(screen.getByRole("button", { name: "Create mission" }));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      sequential: true,
      tasks: [
        { title: "Task 1", prompt: "Do part 1" },
        { title: "Task 2", prompt: "Do part 2" },
      ],
    }),
  );
});
test("Markdown renders linked notes and tables without executing raw HTML", async () => {
  const link = vi.fn();
  const user = userEvent.setup();
  const { container } = render(
    <MD onLink={link}>
      {
        '# Map\n\n[[Decisions]]\n\n| Path | Files |\n| --- | ---: |\n| src | 3 |\n\n<script>alert("no")</script>'
      }
    </MD>,
  );
  expect(screen.getByRole("table")).toBeTruthy();
  expect(container.querySelector("script")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Decisions" }));
  expect(link).toHaveBeenCalledWith("Decisions");
});
test("Sentinel presents the audit boundary and requires an explained decision", async () => {
  const fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ id: "finding-1" }),
  }));
  vi.stubGlobal("fetch", fetch);
  const user = userEvent.setup();
  render(
    <Sentinel
      findings={[
        {
          id: "finding-1",
          runId: "run-1",
          state: "suspected",
          title: "TLS verification disabled",
          severity: "high",
          path: "api.js",
          line: 3,
          evidence: "rejectUnauthorized: false",
          advice: "Check certificate configuration.",
        },
      ]}
      runs={[]}
      act={(fn) => fn()}
      goRun={() => {}}
    />,
  );
  expect(screen.getByText(/does not intercept commands/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Record decision" }));
  expect(screen.getByLabelText("Reason").required).toBe(true);
  await user.selectOptions(
    screen.getByLabelText("Resolution"),
    "false-positive",
  );
  await user.type(
    screen.getByLabelText("Reason"),
    "Only used in an isolated test fixture.",
  );
  await user.click(screen.getByRole("button", { name: "Save decision" }));
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
    state: "false-positive",
    reason: "Only used in an isolated test fixture.",
  });
});
test("keyboard jump navigation opens project brain", async () => {
  const project = {
    id: "project-1",
    name: "Fixture",
    branch: "main",
    brainUpdatedAt: "now",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => ({
      ok: true,
      json: async () =>
        url.endsWith("/brain")
          ? {
              vaultPath: "/test/brain",
              notes: [
                {
                  filename: "Home.md",
                  title: "Home",
                  content: "# Fixture brain",
                  generated: true,
                  links: [],
                },
              ],
            }
          : { ...emptyState, projects: [project] },
    })),
  );
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("button", { name: "Search workspace", exact: true });
  await user.keyboard("{Control>}k{/Control}");
  const dialog = screen.getByRole("dialog", { name: "Jump to" });
  await user.click(
    within(dialog).getByRole("button", { name: "Project brain" }),
  );
  fireEvent.keyDown(
    await screen.findByRole("button", { name: "Open note: Home" }),
    { key: "Enter" },
  );
  expect(
    await screen.findByRole("heading", { name: "Fixture brain" }),
  ).toBeTruthy();
  expect(screen.getByText("Auto-maintained")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Edit note" })).toBeNull();
});
