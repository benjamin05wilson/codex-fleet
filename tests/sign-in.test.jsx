import React from "react";
import { afterEach, test, expect, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SignInGate } from "../src/features/sign-in.jsx";
afterEach(() => {
  cleanup();
  delete window.fleetDesktop;
});
test("signed-out users see sign-in, not an editable chat or raw 401; opens only the provided official URL", async () => {
  let authenticated = false;
  const request = vi.fn(async (path) =>
    path === "/auth/login"
      ? { authUrl: "https://auth.openai.com/authorize?state=fixture" }
      : { authenticated, available: true },
  );
  const open = vi.fn(async () => {}),
    ready = vi.fn();
  window.fleetDesktop = { openSignIn: open };
  render(
    <SignInGate
      initial={{ authenticated: false }}
      request={request}
      onReady={ready}
    />,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Sign in with ChatGPT" }),
  );
  expect(open).toHaveBeenCalledExactlyOnceWith(
    "https://auth.openai.com/authorize?state=fixture",
  );
  expect(screen.getByText("Finish signing in.")).toBeTruthy();
  expect(screen.queryByText(/401/)).toBeNull();
  authenticated = true;
  await user.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(ready).toHaveBeenCalled();
});
test("Windows sandbox setup is explicit and cancelled setup remains blocked", async () => {
  const state = { authenticated: true, available: true, sandboxRequired: true };
  const request = vi.fn(async () => ({
    ...state,
    error: "Windows setup was cancelled.",
  }));
  render(<SignInGate initial={state} request={request} />);
  const user = userEvent.setup();
  expect(request).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Set up Windows sandbox" }),
  );
  expect(request).toHaveBeenCalledWith("/auth/windows-setup", "POST", {
    approved: true,
  });
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("cancelled");
});
