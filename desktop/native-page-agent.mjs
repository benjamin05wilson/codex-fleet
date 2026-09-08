// Fixed, application-owned DOM operations run in an isolated JS world. Tool
// input is data, never JavaScript, CSS selectors, file paths or debugger calls.
export function pageOperation(input) {
  const label = (el) =>
    (
      el.getAttribute("aria-label") ||
      el.labels?.[0]?.textContent ||
      el.getAttribute("placeholder") ||
      el.textContent ||
      el.getAttribute("alt") ||
      ""
    )
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 180);
  const signature = (el) =>
    JSON.stringify([
      el.tagName,
      el.getAttribute("type"),
      el.getAttribute("href"),
      label(el),
    ]);
  if (input.action === "snapshot") {
    const refs = new Map();
    const lines = [];
    const links = {};
    let i = 0;
    for (const el of document.querySelectorAll(
      'a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[contenteditable="true"]',
    )) {
      if (i >= 180) break;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(el).visibility === "hidden")
        continue;
      const ref = "@e" + input.nonce + ++i;
      refs.set(ref, { el, signature: signature(el) });
      if (el.hasAttribute("href")) {
        try {
          links[ref] = new URL(el.getAttribute("href"), document.baseURI).href;
        } catch {
          // Invalid and non-URL href values remain ordinary untrusted text.
        }
      }
      lines.push(
        `${ref} ${el.getAttribute("role") || el.tagName.toLowerCase()} ${label(el)}${el.disabled ? " [disabled]" : ""}`,
      );
    }
    window.__fleetNativeElements = {
      refs,
      url: location.href,
      generation: input.generation,
    };
    return {
      title: document.title,
      url: location.href,
      text: (document.body?.innerText || "").slice(0, 22000),
      elements: lines,
      links,
      scope:
        "Main document only; iframe and closed-shadow controls are not exposed. Input values are omitted. References expire after navigation or another snapshot. Valid HTTP(S) link destinations appear in links and can be passed to navigate if a click is obscured; navigate still applies Fleet's network policy.",
    };
  }
  if (input.action === "scroll") {
    const vertical = ["up", "down"].includes(input.text);
    window.scrollBy({
      left: vertical ? 0 : (input.text === "left" ? -1 : 1) * innerWidth * 0.7,
      top: vertical ? (input.text === "up" ? -1 : 1) * innerHeight * 0.7 : 0,
      behavior: "instant",
    });
    return { scrolled: true };
  }
  const snapshot = window.__fleetNativeElements;
  const target = snapshot?.refs.get(input.target);
  if (
    !target ||
    snapshot.url !== location.href ||
    snapshot.generation !== input.generation ||
    !target.el.isConnected ||
    signature(target.el) !== target.signature
  )
    throw new Error(
      "Page or element changed. Take a fresh snapshot before interacting.",
    );
  const el = target.el;
  if (el.disabled || el.getAttribute("aria-disabled") === "true")
    throw new Error("Element is disabled.");
  if (el instanceof HTMLInputElement && ["file", "password"].includes(el.type))
    throw new Error(
      "Enter passwords and select files yourself in the native browser.",
    );
  el.scrollIntoView({
    block: "center",
    inline: "nearest",
    behavior: "instant",
  });
  const r = el.getBoundingClientRect(),
    top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!r.width || !r.height || !top || !(top === el || el.contains(top)))
    throw new Error(
      "Element is obscured or not visible. Take a fresh snapshot; if it is a link with an exposed destination, use navigate with that URL instead of retrying the click or pressing Tab.",
    );
  if (input.action === "click") {
    el.click();
    return { clicked: input.target };
  }
  if (input.action === "fill") {
    if (el.readOnly) throw new Error("Element is read-only.");
    el.focus();
    const prototype =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : el instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : null;
    if (prototype)
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(
        el,
        input.text,
      );
    else if (el.isContentEditable) el.textContent = input.text;
    else throw new Error("Element is not editable.");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { filled: input.target };
  }
  throw new Error("Unsupported page operation.");
}

export function createNativePageAgent({
  web,
  browserURL,
  forbiddenPorts,
  validateAction,
}) {
  let disposed = false,
    nonce = 0,
    generation = 0,
    attached = false;
  const navigate = (_event, _url, _inPlace, main) => {
    if (main !== false) generation++;
  };
  web.on("did-start-navigation", navigate);
  const alive = () => {
    if (disposed || web.isDestroyed())
      throw new Error("Native browser closed.");
  };
  const dom = async (input) => {
    const reply = await web.executeJavaScriptInIsolatedWorld(999, [
      {
        code: `(() => { try { return { value: (${pageOperation.toString()})(${JSON.stringify(input)}) }; } catch (error) { return { error: String(error.message).slice(0,500) }; } })()`,
      },
    ]);
    if (reply.error) throw new Error(reply.error);
    return reply.value;
  };
  const keys = {
    Enter: 13,
    Tab: 9,
    Escape: 27,
    Backspace: 8,
    Delete: 46,
    ArrowUp: 38,
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    Home: 36,
    End: 35,
    Space: 32,
  };
  return {
    async execute(input) {
      alive();
      validateAction(input);
      // No evaluation or data reading on a privileged/custom page, even if a
      // navigation was interrupted after the main-process navigation guard.
      if (input.action !== "navigate") browserURL(web.getURL(), forbiddenPorts);
      if (input.action === "navigate") {
        const url = browserURL(input.url, forbiddenPorts);
        await web.loadURL(url.href);
        alive();
        return { url: web.getURL(), title: web.getTitle() };
      }
      if (["back", "forward", "reload"].includes(input.action)) {
        if (input.action === "reload") web.reload();
        if (input.action === "back" && web.navigationHistory.canGoBack())
          web.navigationHistory.goBack();
        if (input.action === "forward" && web.navigationHistory.canGoForward())
          web.navigationHistory.goForward();
        return { navigating: true };
      }
      if (input.action === "screenshot") {
        const image = (await web.capturePage()).toPNG().toString("base64");
        if (image.length > 12000000)
          throw new Error("Screenshot exceeds the tool size limit.");
        return { image };
      }
      if (input.action === "press") {
        if (!attached) {
          web.debugger.attach("1.3");
          attached = true;
        }
        const selectAll = ["Control+a", "Meta+a"].includes(input.text);
        const key = selectAll ? "a" : input.text === "Space" ? " " : input.text;
        const params = {
          key,
          windowsVirtualKeyCode: selectAll ? 65 : keys[input.text],
          modifiers:
            input.text === "Meta+a" ? 4 : input.text === "Control+a" ? 2 : 0,
        };
        await web.debugger.sendCommand("Input.dispatchKeyEvent", {
          ...params,
          type: "keyDown",
          ...(selectAll
            ? { commands: ["selectAll"] }
            : input.text === "Enter"
              ? { text: "\r" }
              : input.text === "Space"
                ? { text: " " }
                : {}),
        });
        await web.debugger.sendCommand("Input.dispatchKeyEvent", {
          ...params,
          type: "keyUp",
        });
        return { pressed: input.text };
      }
      const before = generation;
      const result = await dom({
        ...input,
        generation,
        ...(input.action === "snapshot"
          ? { nonce: `${Date.now()}${++nonce}` }
          : {}),
      });
      alive();
      if (input.action === "snapshot" && generation !== before)
        throw new Error(
          "Page navigated during snapshot. Take a fresh snapshot.",
        );
      if (input.action === "snapshot") {
        result.links = Object.fromEntries(
          Object.entries(result.links || {}).flatMap(([ref, value]) => {
            try {
              if (!/^@e\d{1,30}$/.test(ref)) return [];
              return [[ref, browserURL(value, forbiddenPorts).href]];
            } catch {
              return [];
            }
          }),
        );
      }
      return result;
    },
    close() {
      disposed = true;
      web.removeListener("did-start-navigation", navigate);
      if (attached && !web.isDestroyed() && web.debugger.isAttached())
        web.debugger.detach();
    },
  };
}
