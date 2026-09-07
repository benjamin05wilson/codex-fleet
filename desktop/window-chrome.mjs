// Keep native Windows window controls and resizing, without the system's light
// title bar. The renderer reserves the same 32px for the draggable Fleet bar.
export function windowChrome(platform = process.platform) {
  return platform === "win32"
    ? {
        titleBarStyle: "hidden",
        titleBarOverlay: {
          color: "#151619",
          symbolColor: "#e5e7eb",
          height: 32,
        },
      }
    : {};
}

export function removeWindowsMenu(window, platform = process.platform) {
  if (platform === "win32") window.setMenu(null);
}
