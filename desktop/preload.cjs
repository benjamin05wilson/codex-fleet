const { contextBridge, ipcRenderer } = require("electron");
// Only a user-driven directory picker; no filesystem, shell or arbitrary IPC access.
contextBridge.exposeInMainWorld(
  "fleetDesktop",
  Object.freeze({
    platform: process.platform,
    version: "0.2.0",
    chooseRepository: () => ipcRenderer.invoke("fleet:choose-repository"),
  }),
);
