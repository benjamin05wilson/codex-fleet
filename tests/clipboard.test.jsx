import React from "react";
import { test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { CodeBlock } from "../src/features/chat-extras.jsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const code = 'const greeting = "hello";\nconsole.log(greeting);';
function renderCode() {
  render(
    <CodeBlock>
      <code className="language-js">{code + "\n"}</code>
    </CodeBlock>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
}
test("Copy code uses the desktop bridge even when browser clipboard access is denied", async () => {
  const writeClipboard = vi.fn().mockResolvedValue(undefined);
  const browserWrite = vi.fn().mockRejectedValue(new Error("Denied"));
  vi.stubGlobal("fleetDesktop", { writeClipboard });
  vi.stubGlobal("navigator", { clipboard: { writeText: browserWrite } });
  renderCode();
  expect(await screen.findByText("Copied")).toBeTruthy();
  expect(writeClipboard).toHaveBeenCalledWith(code);
  expect(browserWrite).not.toHaveBeenCalled();
});
test("Copy code uses the browser clipboard when outside the desktop app", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("fleetDesktop", undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  renderCode();
  expect(await screen.findByText("Copied")).toBeTruthy();
  expect(writeText).toHaveBeenCalledWith(code);
});
test("Copy code reports a failed desktop write without claiming success", async () => {
  vi.stubGlobal("fleetDesktop", {
    writeClipboard: vi.fn().mockRejectedValue(new Error("Unavailable")),
  });
  renderCode();
  expect(await screen.findByText("Copy failed")).toBeTruthy();
});
