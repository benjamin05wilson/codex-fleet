import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, RefreshCw } from "lucide-react";

export function NativeBrowser({ project, initialURL, onBack, onClosePanel }) {
  const [state, setState] = useState(null),
    [url, setUrl] = useState(initialURL || ""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [closing, setClosing] = useState(false);
  const host = useRef(null),
    alive = useRef(true),
    focused = useRef(false),
    session = useRef(null);
  const invoke = (input) => window.fleetDesktop.nativeBrowser(input);
  useEffect(() => {
    alive.current = true;
    invoke({ action: "restore", projectId: project.id })
      .then((next) => {
        if (alive.current && next && !session.current) {
          session.current = next.id;
          setState(next);
          setUrl(next.url || "");
        }
      })
      .catch((e) => {
        if (alive.current) setError(e.message);
      });
    return () => {
      alive.current = false;
      if (session.current)
        invoke({ action: "layout", id: session.current, visible: false }).catch(
          () => {},
        );
    };
  }, []);
  const action = async (action, extra = {}) => {
    setBusy(true);
    setError("");
    try {
      const next = await invoke({ action, id: session.current, ...extra });
      if (action === "start") {
        if (!alive.current) {
          await invoke({ action: "close", id: next.id });
          return;
        }
        session.current = next.id;
      }
      if (alive.current && next) setState(next);
    } catch (e) {
      if (alive.current) setError(e.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (!state?.id || closing) return;
    let stopped = false,
      pending = false;
    const update = async () => {
      if (pending || stopped) return;
      pending = true;
      try {
        const next = await invoke({ action: "state", id: state.id });
        if (!stopped) {
          setState((previous) =>
            previous &&
            Object.keys(next).every((key) => previous[key] === next[key])
              ? previous
              : next,
          );
          if (!focused.current && next.url) setUrl(next.url);
        }
      } catch (e) {
        if (!stopped) setError(e.message);
      } finally {
        pending = false;
      }
    };
    const timer = setInterval(update, 700);
    update();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [state?.id, closing]);
  useEffect(() => {
    if (!state?.id || !host.current) return;
    let stopped = false,
      raf;
    const panel = host.current.closest(".tool-scroll");
    const layout = () => {
      if (stopped) return;
      const element = host.current,
        r = element.getBoundingClientRect();
      const bottom = Math.min(
        innerHeight,
        panel ? panel.getBoundingClientRect().bottom : innerHeight,
      );
      const height = Math.max(0, bottom - r.top);
      if (Math.abs(r.height - height) > 1) {
        element.style.height = `${height}px`;
        schedule();
        return;
      }
      const bounds = { x: r.left, y: r.top, width: r.width, height: r.height };
      const points = [
        [r.left + 2, r.top + 2],
        [r.right - 2, r.top + 2],
        [r.left + 2, r.bottom - 2],
        [r.right - 2, r.bottom - 2],
        [r.left + r.width / 2, r.top + r.height / 2],
      ];
      const visible =
        !closing &&
        !document.hidden &&
        r.width >= 32 &&
        r.height >= 32 &&
        r.left >= 0 &&
        r.top >= 0 &&
        r.right <= innerWidth &&
        r.bottom <= innerHeight &&
        !document.querySelector(
          '[role="dialog"], [role="menu"], dialog[open]',
        ) &&
        points.every(([x, y]) =>
          element.contains(document.elementFromPoint(x, y)),
        );
      invoke({ action: "layout", id: state.id, bounds, visible }).catch(
        () => {},
      );
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(layout);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(host.current);
    if (panel) observer.observe(panel);
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("visibilitychange", schedule);
    const timer = setInterval(layout, 500);
    schedule();
    return () => {
      stopped = true;
      clearInterval(timer);
      cancelAnimationFrame(raf);
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("visibilitychange", schedule);
      invoke({ action: "layout", id: state.id, visible: false }).catch(
        () => {},
      );
    };
  }, [state?.id, closing]);
  return (
    <section
      className="project-browser native-preview"
      aria-label="Project browser"
    >
      <header className="browser-controls">
        <strong>Browser</strong>
        <span>
          {!state
            ? "You + project agents"
            : state.agentConnected
              ? "You + agents · Live"
              : "Connecting agents…"}
        </span>
        {state && (
          <button onClick={() => setClosing(true)}>Close browser</button>
        )}
        {!state && onBack && <button onClick={onBack}>Back to Fleet</button>}
        {onClosePanel && (
          <button
            aria-label="Close session tool"
            title="Hide browser panel"
            onClick={onClosePanel}
          >
            ×
          </button>
        )}
      </header>
      {!state ? (
        <form
          className="browser-start"
          onSubmit={(e) => {
            e.preventDefault();
            action("start", { projectId: project.id, url, approved: true });
          }}
        >
          <h3>Open a website</h3>
          <p>
            The page renders directly inside Fleet at your screen’s resolution.
            Each browser uses a temporary session with in-memory caching.
          </p>
          <label>
            Website or local preview
            <input
              required
              aria-label="Browser URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <small>
            You and this project’s coding agents share this page automatically.
            Ask a chat to open a website and it opens this panel for you. No
            control switching or browser-action approval prompts. Permissions,
            downloads and pop-up windows are disabled. Closing the browser or
            opening another project’s browser clears its session. Switching chat
            tools keeps this same browser open.
          </small>
          <button type="submit" disabled={busy}>
            {busy ? "Opening…" : "Open browser"}
          </button>
        </form>
      ) : (
        <>
          <form
            className="browser-address"
            onSubmit={(e) => {
              e.preventDefault();
              action("navigate", { url });
            }}
          >
            <button
              type="button"
              aria-label="Native back"
              disabled={!state.canBack}
              onClick={() => action("back")}
            >
              <ArrowLeft size={16} />
            </button>
            <button
              type="button"
              aria-label="Native forward"
              disabled={!state.canForward}
              onClick={() => action("forward")}
            >
              <ArrowRight size={16} />
            </button>
            <button
              type="button"
              aria-label="Reload native page"
              onClick={() => action("reload")}
            >
              <RefreshCw size={16} />
            </button>
            <input
              aria-label="Native address"
              value={url}
              onFocus={() => (focused.current = true)}
              onBlur={() => (focused.current = false)}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button disabled={busy}>Go</button>
          </form>
          {closing && (
            <div className="browser-prompt">
              <strong>Close this browser?</strong>
              <p>
                Its temporary cookies, cache and unsaved page state will be
                cleared.
              </p>
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await invoke({ action: "close", id: session.current });
                    session.current = null;
                    if (alive.current) {
                      setState(null);
                      setClosing(false);
                      setError("");
                      onBack?.();
                    }
                  } catch (e) {
                    if (alive.current) setError(e.message);
                  } finally {
                    if (alive.current) setBusy(false);
                  }
                }}
              >
                Confirm close
              </button>
              <button disabled={busy} onClick={() => setClosing(false)}>
                Keep browsing
              </button>
            </div>
          )}
          <div
            ref={host}
            className="native-browser-surface"
            aria-label="Native browser surface"
          />
        </>
      )}
      {(error || state?.error) && <p role="alert">{error || state.error}</p>}
      {state?.agentError && (
        <p role="status">
          Agent connection: {state.agentError} Manual browsing remains available
          in this same page.
        </p>
      )}
    </section>
  );
}
