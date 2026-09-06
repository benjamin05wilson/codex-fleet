import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectBrowser } from "../src/features/browser.jsx";
import { api } from "../src/ui.jsx";
vi.mock("../src/ui.jsx", () => ({
  api: vi.fn(),
  Button: ({ primary, children, ...props }) => (
    <button {...props}>{children}</button>
  ),
}));
const project = { id: "project-a", name: "Example" },
  run = { id: "run-a", title: "Build the app", status: "draft" };
let state;
beforeEach(() => {
  state = { status: "closed", available: true };
  api.mockReset();
  api.mockImplementation(async (path, method, input) => {
    if (path.endsWith("/frame"))
      return { image: "data:image/jpeg;base64,AA", width: 1280, height: 800 };
    if (path.endsWith("/tabs"))
      return [
        {
          id: "t1",
          title: "Example page",
          active: true,
          url: "http://localhost:3000",
        },
      ];
    if (method === "POST") {
      if (path.endsWith("/start"))
        state = {
          status: "open",
          controller: "human",
          canControl: true,
          url: input.url,
          width: 1280,
          height: 800,
          origins: [input.url],
        };
      if (path.endsWith("/grant"))
        state = {
          ...state,
          controller: "agent",
          canControl: false,
          agentRunId: input.runId,
        };
      if (path.endsWith("/take"))
        state = {
          ...state,
          controller: "human",
          canControl: true,
          pending: null,
        };
      if (path.endsWith("/stop")) state = { status: "closed", available: true };
      if (path.endsWith("/control")) return { output: "test page evidence" };
    }
    return { ...state };
  });
});
afterEach(cleanup);
test("a lost backend connection shows recovery guidance and clears after reconnection", async () => {
  api.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  render(<ProjectBrowser project={project} run={run} />);
  await screen.findByText(/Cannot reach Fleet/);
  await waitFor(
    () =>
      expect(screen.getByRole("button", { name: "Open browser" })).toBeTruthy(),
    { timeout: 2500 },
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(api.mock.calls.some((c) => c[1] === "POST")).toBe(false);
});
test("browser never auto-starts and requires a URL and explicit consent", async () => {
  const user = userEvent.setup();
  render(<ProjectBrowser project={project} run={run} />);
  const open = await screen.findByRole("button", { name: "Open browser" });
  expect(open.disabled).toBe(true);
  expect(api.mock.calls.some((c) => c[1] === "POST")).toBe(false);
  await user.type(
    screen.getByLabelText("Website or local preview"),
    "http://localhost:3000",
  );
  expect(open.disabled).toBe(true);
  await user.click(screen.getByRole("checkbox"));
  await user.click(open);
  await screen.findByRole("img", { name: "Live project browser page" });
  expect(api).toHaveBeenCalledWith(
    "/projects/project-a/browser/start",
    "POST",
    { url: "http://localhost:3000", origins: [], approved: true },
  );
});
test("sharing is explicit, disables manual input, and take control restores it", async () => {
  state = {
    status: "open",
    controller: "human",
    canControl: true,
    url: "http://localhost:3000",
    width: 1280,
    height: 800,
  };
  const user = userEvent.setup();
  render(<ProjectBrowser project={project} run={run} />);
  await user.click(
    await screen.findByRole("button", { name: "Let this chat browse" }),
  );
  expect(api.mock.calls.some((c) => c[0].endsWith("/grant"))).toBe(false);
  await user.click(screen.getByRole("button", { name: "Share browser" }));
  await screen.findByText("Shared with a chat");
  expect(screen.getByLabelText("Browser address").disabled).toBe(true);
  const before = api.mock.calls.length;
  fireEvent.keyDown(screen.getByRole("group", { name: /Browser page/ }), {
    key: "a",
  });
  expect(api.mock.calls.length).toBe(before);
  await user.click(screen.getByRole("button", { name: "Take control" }));
  await screen.findByText("You control this browser");
  expect(screen.getByLabelText("Browser address").disabled).toBe(false);
});
test("another window is observer-only and closing requires confirmation", async () => {
  state = {
    status: "open",
    controller: "human",
    canControl: false,
    url: "http://localhost:3000",
    width: 1280,
    height: 800,
  };
  const user = userEvent.setup();
  render(<ProjectBrowser project={project} run={run} />);
  await screen.findByText("Controlled in another window");
  expect(
    screen.getByRole("button", { name: "Reload browser page" }).disabled,
  ).toBe(true);
  await user.click(
    screen.getByRole("button", { name: "Close project browser" }),
  );
  expect(api.mock.calls.some((c) => c[0].endsWith("/stop"))).toBe(false);
  await user.click(screen.getByRole("button", { name: "Close browser" }));
  await screen.findByRole("button", { name: "Open browser" });
});
test("pending actions can be denied and page evidence only goes to a draft", async () => {
  state = {
    status: "open",
    controller: "agent",
    canControl: false,
    url: "http://localhost:3000",
    width: 1280,
    height: 800,
    pending: { id: "approval-a", action: "click", target: "@e1" },
  };
  const user = userEvent.setup(),
    onEvidence = vi.fn();
  render(
    <ProjectBrowser project={project} run={run} onEvidence={onEvidence} />,
  );
  await user.click(await screen.findByRole("button", { name: "Deny" }));
  expect(api).toHaveBeenCalledWith(
    "/projects/project-a/browser/approve",
    "POST",
    { id: "approval-a", approved: false },
  );
  await user.click(screen.getByRole("button", { name: "Take control" }));
  await user.click(await screen.findByRole("button", { name: "Page text" }));
  await screen.findByText("test page evidence");
  expect(onEvidence).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Send to chat draft" }));
  expect(onEvidence).toHaveBeenCalledWith(
    expect.stringContaining("untrusted page content"),
  );
});
