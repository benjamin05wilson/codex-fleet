import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectBrowser } from "../../src/features/browser.jsx";
import "../../src/browser.css";
const root = createRoot(document.getElementById("root"));
function BrowserFixture() {
  const [request, setRequest] = useState(null);
  useEffect(() => window.fleetDesktop.onBrowserRequested(setRequest), []);
  return (
    <ProjectBrowser
      key={request?.id || "manual"}
      project={{ id: "trial", name: "Native UI trial" }}
      run={{
        preview: { url: new URLSearchParams(location.search).get("url") },
      }}
    />
  );
}
root.render(<BrowserFixture />);
