// CDP exposes embedded documents and closed shadow roots without accepting
// executable code from a tool caller. Element references are snapshot-scoped.
export function createNativeDOM(web) {
  let refs = new Map(),
    sequence = 0;
  const sessions = new Set();
  const contexts = new Map();
  const pending = new Set();
  let enabled = false;
  const message = (_event, method, params) => {
    if (
      method === "Target.attachedToTarget" &&
      params.targetInfo.type === "iframe"
    ) {
      sessions.add(params.sessionId);
      const task = web.debugger
        .sendCommand(
          "Target.setAutoAttach",
          { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
          params.sessionId,
        )
        .catch(() => {})
        .finally(() => pending.delete(task));
      pending.add(task);
    }
    if (method === "Target.detachedFromTarget")
      sessions.delete(params.sessionId);
  };
  web.debugger?.on("message", message);
  const send = (method, params = {}, sessionId) => {
    if (!web.debugger.isAttached()) web.debugger.attach("1.3");
    return web.debugger.sendCommand(method, params, sessionId);
  };
  const call = async (node, fn, args = []) => {
    const command = (method, params) => send(method, params, node.sessionId);
    const contextKey = `${node.sessionId || "main"}:${node.frameId}`;
    if (!contexts.has(contextKey)) {
      const result = await command("Page.createIsolatedWorld", {
        frameId: node.frameId,
        worldName: "fleet-native-elements",
      });
      contexts.set(contextKey, result.executionContextId);
    }
    const { object } = await command("DOM.resolveNode", {
      executionContextId: contexts.get(contextKey),
      backendNodeId: node.backendNodeId,
    });
    if (!object?.objectId)
      throw new Error("Element changed. Take a fresh snapshot.");
    try {
      const result = await command("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: fn.toString(),
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        userGesture: true,
      });
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.exception?.description ||
            "Element interaction failed.",
        );
      return result.result?.value;
    } finally {
      await command("Runtime.releaseObject", { objectId: object.objectId });
    }
  };
  return {
    clear() {
      refs.clear();
      contexts.clear();
    },
    close() {
      web.debugger?.removeListener("message", message);
      refs.clear();
      contexts.clear();
    },
    async snapshot() {
      if (!enabled) {
        await send("Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        });
        enabled = true;
      }
      await Promise.all([...pending]);
      refs = new Map();
      const nodes = [];
      const visit = (node, sessionId, frameId) => {
        if (node.nodeType === 1) {
          const attrs = Object.fromEntries(
            Array.from(
              { length: (node.attributes || []).length / 2 },
              (_, i) => [node.attributes[i * 2], node.attributes[i * 2 + 1]],
            ),
          );
          if (
            ["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT", "SUMMARY"].includes(
              node.nodeName,
            ) ||
            ["button", "link"].includes(attrs.role) ||
            attrs.contenteditable === "true"
          )
            nodes.push({ ...node, sessionId, frameId });
        }
        for (const child of [
          ...(node.children || []),
          ...(node.shadowRoots || []),
          ...(node.contentDocument ? [node.contentDocument] : []),
        ])
          visit(
            child,
            sessionId,
            child === node.contentDocument ? node.frameId || frameId : frameId,
          );
      };
      for (const sessionId of [undefined, ...sessions]) {
        try {
          const { root } = await send(
            "DOM.getDocument",
            { depth: -1, pierce: true },
            sessionId,
          );
          const { frameTree } = await send("Page.getFrameTree", {}, sessionId);
          visit(root, sessionId, frameTree.frame.id);
        } catch (error) {
          if (!sessionId || sessions.has(sessionId)) throw error;
        }
      }
      const elements = [],
        links = {};
      const prefix = `${Date.now()}${++sequence}`;
      for (const node of nodes) {
        const info = await call(node, function () {
          const r = this.getBoundingClientRect();
          if (
            (!r.width ||
              !r.height ||
              getComputedStyle(this).visibility === "hidden") &&
            this.type !== "file"
          )
            return null;
          return {
            label: (
              this.getAttribute("aria-label") ||
              this.labels?.[0]?.textContent ||
              this.getAttribute("placeholder") ||
              this.textContent ||
              this.getAttribute("alt") ||
              ""
            )
              .trim()
              .replace(/\s+/g, " "),
            role: this.getAttribute("role") || this.tagName.toLowerCase(),
            type: this.getAttribute("type"),
            href: this.getAttribute("href"),
            url: this.href,
            disabled: !!this.disabled,
          };
        });
        if (!info) continue;
        const ref = `@e${prefix}${refs.size + 1}`;
        refs.set(ref, { node, info });
        elements.push(
          `${ref} ${info.role} ${info.label}${info.disabled ? " [disabled]" : ""}`,
        );
        if (typeof info.url === "string") links[ref] = info.url;
      }
      return {
        elements,
        links,
        scope:
          "Document, embedded frames and shadow controls. Input values are omitted. References expire on navigation or another snapshot.",
      };
    },
    async execute(input) {
      const ref = refs.get(input.target);
      if (!ref) throw new Error("Take a fresh snapshot before interacting.");
      await call(
        ref.node,
        function (info) {
          if (
            !this.isConnected ||
            this.getAttribute("type") !== info.type ||
            this.getAttribute("href") !== info.href ||
            (
              this.getAttribute("aria-label") ||
              this.labels?.[0]?.textContent ||
              this.getAttribute("placeholder") ||
              this.textContent ||
              this.getAttribute("alt") ||
              ""
            )
              .trim()
              .replace(/\s+/g, " ") !== info.label
          )
            throw new Error("Element changed. Take a fresh snapshot.");
          if (this.disabled || this.getAttribute("aria-disabled") === "true")
            throw new Error("Element is disabled.");
        },
        [ref.info],
      );
      if (input.action === "upload") {
        if (ref.info.type !== "file")
          throw new Error("Choose a file input from the snapshot.");
        await send(
          "DOM.setFileInputFiles",
          {
            backendNodeId: ref.node.backendNodeId,
            files: input.files,
          },
          ref.node.sessionId,
        );
        return { uploaded: input.target, count: input.files.length };
      }
      await call(
        ref.node,
        function (action, text) {
          this.scrollIntoView({
            block: "center",
            inline: "nearest",
            behavior: "instant",
          });
          const r = this.getBoundingClientRect();
          let top = this.getRootNode().elementFromPoint?.(
            r.left + r.width / 2,
            r.top + r.height / 2,
          );
          // Check each containing shadow tree, including closed roots.
          let candidate = this;
          while (candidate) {
            const root = candidate.getRootNode();
            top = root.elementFromPoint?.(
              r.left + r.width / 2,
              r.top + r.height / 2,
            );
            if (top && top !== candidate && !candidate.contains(top))
              throw new Error("Element is obscured. Take a fresh snapshot.");
            candidate = root.host;
          }
          if (!r.width || !r.height) throw new Error("Element is not visible.");
          if (action === "click") {
            this.click();
            return;
          }
          if (this.readOnly) throw new Error("Element is read-only.");
          this.focus();
          const view = this.ownerDocument.defaultView;
          const prototype =
            this instanceof view.HTMLTextAreaElement
              ? view.HTMLTextAreaElement.prototype
              : this instanceof view.HTMLInputElement
                ? view.HTMLInputElement.prototype
                : this instanceof view.HTMLSelectElement
                  ? view.HTMLSelectElement.prototype
                  : null;
          if (prototype)
            Object.getOwnPropertyDescriptor(prototype, "value").set.call(
              this,
              text,
            );
          else if (this.isContentEditable) this.textContent = text;
          else throw new Error("Element is not editable.");
          this.dispatchEvent(new view.Event("input", { bubbles: true }));
          this.dispatchEvent(new view.Event("change", { bubbles: true }));
        },
        [input.action, input.text],
      );
      return { [input.action === "fill" ? "filled" : "clicked"]: input.target };
    },
  };
}
