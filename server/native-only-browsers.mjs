// The browser lives in the desktop's WebContentsView. The daemon must never
// launch the retired Chrome/JPEG implementation, including for stale clients.
export const nativeBrowserMessage =
  "Fleet uses its native desktop browser only. Chat browser control is not connected yet; no alternative browser will be opened.";

export class NativeOnlyBrowsers {
  state() {
    return {
      status: "closed",
      available: false,
      mode: "native",
      desktopOnly: true,
      agentAvailable: false,
      error: nativeBrowserMessage,
    };
  }
  connection() {
    return null;
  }
  async close() {}
  unavailable() {
    throw Object.assign(new Error(nativeBrowserMessage), { status: 410 });
  }
  start() {
    return this.unavailable();
  }
  control() {
    return this.unavailable();
  }
  grant() {
    return this.unavailable();
  }
  take() {
    return this.unavailable();
  }
  approve() {
    return this.unavailable();
  }
  agent() {
    return this.unavailable();
  }
  frame() {
    return this.unavailable();
  }
  streamFrames() {
    return this.unavailable();
  }
  tabs() {
    return this.unavailable();
  }
  stop() {
    return this.state();
  }
}
