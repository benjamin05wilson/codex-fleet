import React from "react";
import { afterEach, expect, test, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ProjectBrowser } from "../src/features/browser.jsx";
import { NativeBrowser } from "../src/features/native-browser.jsx";

vi.mock("../src/features/native-browser.jsx", () => ({
  NativeBrowser: vi.fn(({ project, initialURL }) => (
    <div data-testid="native">
      {project.id} {initialURL}
    </div>
  )),
}));
afterEach(() => {
  cleanup();
  delete window.fleetDesktop;
  vi.clearAllMocks();
});

test("desktop opens the native browser directly, with no mode switcher", () => {
  window.fleetDesktop = { nativeBrowser: vi.fn() };
  render(
    <ProjectBrowser
      project={{ id: "one" }}
      run={{ preview: { url: "http://localhost:3000" } }}
    />,
  );
  expect(screen.getByTestId("native").textContent).toBe(
    "one http://localhost:3000",
  );
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByText(/Try native|Chrome view|Share browser/)).toBeNull();
});
test("web and older desktop clients explain the requirement without a fallback", () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("must not fetch"));
  try {
    render(<ProjectBrowser project={{ id: "one" }} />);
    expect(screen.getByText("Open Fleet Desktop to browse")).toBeTruthy();
    expect(
      screen.getByText(/no web or streamed-browser fallback/),
    ).toBeTruthy();
    expect(NativeBrowser).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});
test("project changes select the new project without routing to another browser", () => {
  window.fleetDesktop = { nativeBrowser: vi.fn() };
  const view = render(<ProjectBrowser project={{ id: "one" }} />);
  view.rerender(<ProjectBrowser project={{ id: "two" }} />);
  expect(screen.getByTestId("native").textContent.trim()).toBe("two");
});
