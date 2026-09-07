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

test("native preview is opt-in and explicitly manual, with no automatic browser start", async () => {
  render(<NativeBrowser {...props} onBack={() => {}} />);
  expect(screen.getByText(/Not connected to chats/)).toBeTruthy();
  expect(screen.getByLabelText("Browser URL").value).toBe(
    "https://example.com",
  );
  expect(invoke).not.toHaveBeenCalled();
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
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Open browser" })).toBeTruthy();
});

test("switching projects closes the old native session without auto-starting another", async () => {
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
    expect(invoke).toHaveBeenCalledWith({ action: "close", id: "native-one" }),
  );
  expect(screen.getByLabelText("Browser URL").value).toBe("");
  expect(invoke.mock.calls.filter(([v]) => v.action === "start")).toHaveLength(
    1,
  );
});
