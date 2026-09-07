import React from "react";
import { createRoot } from "react-dom/client";
import { ProjectBrowser } from "../../src/features/browser.jsx";
import "../../src/browser.css";
const root = createRoot(document.getElementById("root"));
root.render(
  <ProjectBrowser
    project={{ id: "trial", name: "Native UI trial" }}
    run={{ preview: { url: new URLSearchParams(location.search).get("url") } }}
  />,
);
