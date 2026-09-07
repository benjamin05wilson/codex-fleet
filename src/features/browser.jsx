import React from "react";
import { NativeBrowser } from "./native-browser.jsx";
import "../browser.css";

// Native rendering is the only product browser. Never start a streamed browser
// when the desktop bridge is missing or when native startup fails.
export function ProjectBrowser({ project, run }) {
  if (typeof window.fleetDesktop?.nativeBrowser !== "function")
    return (
      <section className="project-browser" aria-label="Project browser">
        <h3>Open Fleet Desktop to browse</h3>
        <p>
          Fleet’s browser renders directly in the desktop app. If you are
          already using the desktop app, update and relaunch it to enable the
          browser.
        </p>
        <p>There is no web or streamed-browser fallback.</p>
      </section>
    );
  return (
    <NativeBrowser
      key={project.id}
      project={project}
      initialURL={run?.preview?.url || ""}
    />
  );
}
