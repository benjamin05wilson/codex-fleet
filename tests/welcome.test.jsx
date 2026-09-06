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
import { WelcomeSetup } from "../src/features/welcome-setup.jsx";
import { App } from "../src/main.jsx";
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
const metadata = {
  models: [{ model: "fixture-first", displayName: "First model" }],
};
const initial = {
  csrf: "onboarding-test",
  projects: [],
  runs: [],
  missions: [],
  findings: [],
  onboarding: null,
  status: {
    authenticated: true,
    version: "test-cli",
    concurrency: 3,
    dataDir: "/test/data",
  },
};
test("welcome offers Standard and YOLO only, defaults to editing and gates YOLO behind a separate acknowledgement", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => metadata })),
  );
  const user = userEvent.setup(),
    save = vi.fn();
  render(
    <WelcomeSetup status={initial.status} onSave={save} onSkip={() => {}} />,
  );
  expect(
    screen
      .getByRole("button", { name: /Standard/ })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(screen.queryByRole("button", { name: /Read only/ })).toBeNull();
  expect(
    screen.queryByRole("navigation", { name: "Setup progress" }),
  ).toBeNull();
  expect(screen.queryByLabelText(/Default model/)).toBeNull();
  expect(
    screen.queryByRole("group", { name: "Default working folder" }),
  ).toBeNull();
  expect(
    screen.queryByRole("checkbox", { name: /Suggest a project team/ }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: /YOLO/ }));
  expect(
    screen.getByRole("button", { name: "Start using Fleet" }).disabled,
  ).toBe(true);
  expect(
    screen.getByText(/A Git worktree is not a security boundary/),
  ).toBeTruthy();
  await user.click(
    screen.getByRole("checkbox", { name: /I understand the risks/ }),
  );
  expect(save).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Start using Fleet" }));
  expect(save).toHaveBeenCalledExactlyOnceWith({
    approved: true,
    sandbox: "danger-full-access",
    yoloApproved: true,
  });
});
test("reopening legacy read-only onboarding proposes Standard but changes nothing until saved", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => metadata })),
  );
  const save = vi.fn(),
    cancel = vi.fn(),
    user = userEvent.setup();
  render(
    <WelcomeSetup
      saved={{ sandbox: "read-only" }}
      status={initial.status}
      onSave={save}
      onSkip={cancel}
    />,
  );
  expect(
    screen
      .getByRole("button", { name: /Standard/ })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(screen.queryByRole("button", { name: /Read only/ })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(save).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
});
test("setup makes no model-discovery call, resets YOLO consent on changing permissions, and can be skipped", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw Error("Offline");
    }),
  );
  const user = userEvent.setup(),
    skip = vi.fn();
  render(<WelcomeSetup status={{ authenticated: false }} onSkip={skip} />);
  await user.click(screen.getByRole("button", { name: /YOLO/ }));
  await user.click(screen.getByRole("checkbox", { name: /I understand/ }));
  await user.click(screen.getByRole("button", { name: /Standard/ }));
  await user.click(screen.getByRole("button", { name: /YOLO/ }));
  expect(screen.getByRole("checkbox").checked).toBe(false);
  await user.click(screen.getByRole("button", { name: /Standard/ }));
  expect(fetch).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Set up later" }));
  expect(skip).toHaveBeenCalledOnce();
});
test("first run blocks chat shortcuts, saves defaults without creating chats, and can reopen setup from Settings", async () => {
  let saved = null;
  const request = vi.fn(async (url, opts) => ({
    ok: true,
    json: async () => {
      if (url === "/api/codex") return metadata;
      if (url === "/api/onboarding") {
        saved = JSON.parse(opts.body);
        return saved;
      }
      return { ...initial, onboarding: saved };
    },
  }));
  vi.stubGlobal("fetch", request);
  const user = userEvent.setup();
  const mounted = render(<App />);
  await screen.findByRole("main", { name: "Fleet onboarding" });
  fireEvent.keyDown(document, { key: "n", metaKey: true });
  expect(request.mock.calls.some(([url]) => url.includes("/sessions"))).toBe(
    false,
  );
  await user.click(screen.getByRole("button", { name: "Start using Fleet" }));
  await screen.findByRole("button", { name: "New project", exact: true });
  expect(saved.sandbox).toBe("workspace-write");
  mounted.unmount();
  render(<App />);
  await screen.findByRole("button", { name: "New project", exact: true });
  expect(screen.queryByRole("main", { name: "Fleet onboarding" })).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "Settings", exact: true }),
  );
  await user.click(screen.getByRole("button", { name: "Setup & defaults…" }));
  expect(screen.getByRole("main", { name: "Fleet onboarding" })).toBeTruthy();
  expect(
    request.mock.calls.filter(([, opts]) => opts?.method === "POST"),
  ).toHaveLength(1);
});
test("failed save keeps setup choices visible and allows retry or skip without starting agents", async () => {
  const request = vi.fn(async (url) =>
    url === "/api/onboarding"
      ? {
          ok: false,
          status: 400,
          json: async () => ({ error: "Settings could not be saved" }),
        }
      : {
          ok: true,
          json: async () => (url === "/api/codex" ? metadata : initial),
        },
  );
  vi.stubGlobal("fetch", request);
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: /Standard/ }));
  await user.click(screen.getByRole("button", { name: "Start using Fleet" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Start using Fleet" }).disabled,
    ).toBe(false),
  );
  expect(
    screen
      .getByRole("button", { name: /Standard/ })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  await user.click(screen.getByRole("button", { name: "Set up later" }));
  await screen.findByRole("button", { name: "New project", exact: true });
  expect(request.mock.calls.some(([url]) => url.includes("/sessions"))).toBe(
    false,
  );
});
