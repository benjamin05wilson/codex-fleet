import { createNativePageAgent } from "./native-page-agent.mjs";

export function createNativeTabs(options) {
  const pages = new Map();
  let active,
    sequence = 0;
  const add = (web, window) => {
    const tabId = String(++sequence);
    const child = (popup) => add(popup.webContents, popup);
    web.on("did-create-window", child);
    const agent = createNativePageAgent({ ...options, web });
    pages.set(tabId, { web, window, agent, child });
    active = tabId;
    web.once("destroyed", () => {
      agent.close();
      pages.delete(tabId);
      if (active === tabId) active = pages.keys().next().value;
    });
    return tabId;
  };
  add(options.web);
  return {
    async execute(input) {
      options.validateAction(input);
      if (input.action === "tabs")
        return {
          tabs: [...pages].map(([tabId, p]) => ({
            tabId,
            url: p.web.getURL(),
            title: p.web.getTitle(),
            active: tabId === active,
          })),
        };
      if (input.action === "new_tab") {
        const url = options.browserURL(input.url, options.forbiddenPorts);
        const window = options.createWindow();
        const tabId = add(window.webContents, window);
        await window.loadURL(url.href);
        return { tabId, url: url.href };
      }
      if (["switch_tab", "close_tab"].includes(input.action)) {
        const page = pages.get(input.tabId);
        if (!page) throw new Error("Unknown tab. Use tabs to list open pages.");
        if (input.action === "switch_tab") {
          active = input.tabId;
          page.window?.show();
          page.web.focus();
          return { tabId: active };
        }
        if (!page.window) {
          await page.web.loadURL("about:blank");
          page.web.removeListener("did-create-window", page.child);
          page.agent.close();
          pages.delete(input.tabId);
          if (active === input.tabId) active = pages.keys().next().value;
          return { closed: input.tabId };
        }
        page.window.close();
        return { closed: input.tabId };
      }
      if (
        !pages.has(active) &&
        input.action === "navigate" &&
        !options.web.isDestroyed()
      )
        add(options.web);
      const page = pages.get(active);
      if (!page) throw new Error("No open page. Use new_tab with a URL.");
      return page.agent.execute(input);
    },
    close() {
      for (const page of pages.values()) {
        page.web.removeListener("did-create-window", page.child);
        page.agent.close();
        if (page.window && !page.window.isDestroyed()) page.window.destroy();
      }
      pages.clear();
    },
  };
}
