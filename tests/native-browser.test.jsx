import React from "react";
import { test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { NativeBrowser } from "../src/features/native-browser.jsx";
import { ProjectBrowser } from "../src/features/browser.jsx";
let invoke;
beforeEach(() => {
  invoke = vi.fn(async (input) =>
    ["start", "state", "navigate"].includes(input.action)
      ? {
          id: "native-one",
          url: input.url || "https://example.com",
          canBack: false,
          canForward: false,
        }
      : undefined,
  );
  window.fleetDesktop = { nativeBrowser: invoke };
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function () {
      const height = parseFloat(this.style.height) || 544;
      return {
        x: 10,
        y: 200,
        left: 10,
        top: 200,
        width: 800,
        height,
        right: 810,
        bottom: 200 + height,
      };
    },
  );
  document.elementFromPoint = () =>
    document.querySelector(".native-browser-surface");
});
afterEach(() => {
  cleanup();
  delete window.fleetDesktop;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const props = {
  project: { id: "project-a", name: "Example" },
  initialURL: "https://example.com",
};

test("opening advertises automatic shared access without a connect or takeover step", async () => {
  render(<NativeBrowser {...props} onBack={() => {}} />);
  expect(screen.getByText(/You \+ project agents/)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: /connect|take control|approve/i }),
  ).toBeNull();
  expect(screen.getByLabelText("Browser URL").value).toBe(
    "https://example.com",
  );
  expect(invoke.mock.calls.map(([input]) => input.action)).toEqual(["restore"]);
  fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
  await screen.findByLabelText("Native browser surface");
  expect(invoke).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "start",
      projectId: "project-a",
      approved: true,
      url: "https://example.com",
    }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "layout",
        id: "native-one",
        visible: true,
      }),
    ),
  );
  fireEvent.change(screen.getByLabelText("Native address"), {
    target: { value: "https://example.org" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Go" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "navigate",
        url: "https://example.org",
      }),
    ),
  );
});

test("native view fills tall windows and the actual panel bottom without a gap or height cap", async () => {
  vi.stubGlobal("innerHeight", 1600);
  let bottom = 1500;
  const view = render(
    <div className="tool-scroll">
      <NativeBrowser {...props} />
    </div>,
  );
  view.container.querySelector(".tool-scroll").getBoundingClientRect = () => ({
    bottom,
  });
  fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
  const surface = await screen.findByLabelText("Native browser surface");
  await waitFor(() => expect(surface.style.height).toBe("1300px"));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "layout",
        visible: true,
        bounds: { x: 10, y: 200, width: 800, height: 1300 },
      }),
    ),
  );
  bottom = 700;
  fireEvent(window, new Event("resize"));
  await waitFor(() => expect(surface.style.height).toBe("500px"));
  bottom = 1800;
  fireEvent(window, new Event("resize"));
  await waitFor(() => expect(surface.style.height).toBe("1400px"));
});

test("one browser header keeps hide-panel separate from clearing the browser session", async () => {
  const onClosePanel = vi.fn();
  const view = render(<NativeBrowser {...props} onClosePanel={onClosePanel} />);
  fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
  await screen.findByLabelText("Native browser surface");
  expect(view.container.querySelectorAll("header")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Close browser" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close session tool" }));
  expect(onClosePanel).toHaveBeenCalledOnce();
  expect(invoke.mock.calls.some(([input]) => input.action === "close")).toBe(
    false,
  );
});

test("native close is explicit, hides the surface during confirmation and clears only its own session", async () => {
  const back = vi.fn();
  const view = render(<NativeBrowser {...props} onBack={back} />);
  fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
  await screen.findByLabelText("Native browser surface");
  fireEvent.click(screen.getByRole("button", { name: "Close browser" }));
  expect(back).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "layout",
        id: "native-one",
        visible: false,
      }),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Confirm close" }));
  await waitFor(() => expect(back).toHaveBeenCalledOnce());
  view.unmount();
  expect(invoke.mock.calls.filter(([v]) => v.action === "close")).toEqual([
    [{ action: "close", id: "native-one" }],
  ]);
});

test("unmount during an in-flight start closes the resulting native session", async () => {
  let finish;
  invoke.mockImplementation((input) =>
    input.action === "start"
      ? new Promise((resolve) => (finish = resolve))
      : Promise.resolve(),
  );
  const view = render(<NativeBrowser {...props} onBack={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
  view.unmount();
  finish({ id: "native-late" });
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith({ action: "close", id: "native-late" }),
  );
});

test("the only browser closes back to its own start form and can reopen", async () => {
  render(
    <ProjectBrowser
      project={props.project}
      run={{ preview: { url: props.initialURL } }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
  await screen.findByLabelText("Native browser surface");
  fireEvent.click(screen.getByRole("button", { name: "Close browser" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm close" }));
  await screen.findByRole("button", { name: "Open browser" });
  expect(screen.queryByText(/Chrome view/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
  await screen.findByLabelText("Native browser surface");
  expect(invoke.mock.calls.filter(([v]) => v.action === "start")).toHaveLength(
    2,
  );
});

test("native startup failure is reported without any alternative browser request", async () => {
  invoke.mockRejectedValue(new Error("Native renderer unavailable"));
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("must not fetch"));
  render(
    <ProjectBrowser
      project={props.project}
      run={{ preview: { url: props.initialURL } }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Native renderer unavailable",
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(invoke.mock.calls.map(([input]) => input.action)).toEqual([
    "restore",
    "start",
  ]);
  expect(screen.getByRole("button", { name: "Open browser" })).toBeTruthy();
});

test("switching projects hides the old surface and selects the new native project without auto-starting", async () => {
  const view = render(
    <ProjectBrowser
      project={props.project}
      run={{ preview: { url: props.initialURL } }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
  await screen.findByLabelText("Native browser surface");
  view.rerender(<ProjectBrowser project={{ id: "project-b" }} />);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith({
      action: "restore",
      projectId: "project-b",
    }),
  );
  expect(screen.getByLabelText("Browser URL").value).toBe("");
  expect(invoke.mock.calls.filter(([v]) => v.action === "start")).toHaveLength(
    1,
  );
});

test("switching tools restores the existing shared page without starting or closing it", async () => {
  const view = render(
    <ProjectBrowser
      project={props.project}
      run={{ preview: { url: props.initialURL } }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
  await screen.findByLabelText("Native browser surface");
  view.unmount();
  expect(invoke.mock.calls.some(([input]) => input.action === "close")).toBe(
    false,
  );
  invoke.mockImplementation(async (input) =>
    ["restore", "state"].includes(input.action)
      ? { id: "native-one", url: props.initialURL, agentConnected: true }
      : undefined,
  );
  render(<ProjectBrowser project={props.project} />);
  await screen.findByLabelText("Native browser surface");
  expect(screen.getByText("You + agents · Live")).toBeTruthy();
  expect(
    invoke.mock.calls.filter(([input]) => input.action === "start"),
  ).toHaveLength(1);
});
