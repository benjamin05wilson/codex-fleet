const { contextBridge, ipcRenderer } = require("electron");
// Narrow user-driven desktop APIs; no filesystem, shell or arbitrary IPC access.
contextBridge.exposeInMainWorld(
  "fleetDesktop",
  Object.freeze({
    platform: process.platform,
    version: "0.2.0",
    chooseRepository: () => ipcRenderer.invoke("fleet:choose-repository"),
    nativeBrowser: (input) => ipcRenderer.invoke("fleet:native-browser", input),
    onBrowserRequested: (callback) => {
      const listener = (_event, request) =>
        callback({
          projectId: request.projectId,
          runId: request.runId,
          id: request.id,
        });
      ipcRenderer.on("fleet:browser-requested", listener);
      return () =>
        ipcRenderer.removeListener("fleet:browser-requested", listener);
    },
  }),
);
