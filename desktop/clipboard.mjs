export async function writeClipboard(event, text, window, origin, clipboard) {
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    new URL(event.senderFrame.url).origin !== origin
  )
    throw new Error("Untrusted clipboard request.");
  if (typeof text !== "string") throw new Error("Clipboard text is required.");
  await clipboard.writeText(text);
}
