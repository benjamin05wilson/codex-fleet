import React, { useEffect, useRef, useState } from "react";
import { api, Button, Empty } from "../ui.jsx";
import { Terminal as TerminalIcon, X, Loader2 } from "lucide-react";
import "@xterm/xterm/css/xterm.css";

export function TerminalView({ run, act, standalone = false }) {
  const host = useRef(null);
  const [session, setSession] = useState(null);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const [closed, setClosed] = useState(false);
  const main = run.workspaceKind === "main";
  const open = async () => {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    setError("");
    setClosed(false);
    try {
      const r = await act(async () => {
        try {
          return await api(`/runs/${run.id}/terminal/open`, "POST", {});
        } catch (e) {
          setError(e.message);
          throw e;
        }
      });
      if (r) setSession(r);
      else setError((current) => current || "Could not open the terminal.");
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  };
  useEffect(() => {
    // The sidebar terminal selection is the explicit open action. Re-selecting
    // an existing entry reattaches its owned shell; the server enforces leases.
    if (standalone) open();
  }, [standalone]);
  const close = async () => {
    const r = await act(() =>
      api(`/runs/${run.id}/terminal/close`, "POST", { lease: session.lease }),
    );
    if (r) {
      setSession(null);
      setError("");
      setClosed(true);
    }
  };
  useEffect(() => {
    if (!session || !host.current) return;
    let terminal,
      fit,
      observer,
      events,
      disposed = false;
    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed) return;
      terminal = new Terminal({
        cursorBlink: true,
        fontFamily: "Menlo, monospace",
        fontSize: 13,
        theme: { background: "#111215", foreground: "#e5e7eb" },
        scrollback: 5000,
      });
      fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(host.current);
      const send = (action, data) =>
        api(`/runs/${run.id}/terminal/${action}`, "POST", {
          ...data,
          lease: session.lease,
        }).catch((e) => setError(e.message));
      terminal.onData((data) => send("input", { data }));
      terminal.onResize(({ cols, rows }) => send("resize", { cols, rows }));
      fit.fit();
      terminal.focus();
      observer = new ResizeObserver(() => fit.fit());
      observer.observe(host.current);
      let cursor = 0;
      const load = async () => {
        try {
          const result = await api(`/runs/${run.id}/terminal?after=${cursor}`);
          if (disposed) return;
          for (const item of result.events) {
            terminal.write(item.data);
            cursor = item.seq;
          }
          if (result.exitCode !== undefined)
            setError(
              `Shell exited (${result.exitCode ?? "unknown"}). Close it before starting another.`,
            );
        } catch (e) {
          if (!disposed) {
            setError(e.message);
            if (e.message.includes("No shell is open")) setSession(null);
          }
        }
      };
      await load();
      if (!disposed) events = setInterval(load, 200);
    })().catch((e) => {
      if (!disposed) setError(e.message);
    });
    return () => {
      disposed = true;
      clearInterval(events);
      observer?.disconnect();
      terminal?.dispose();
    };
  }, [session, run.id]);
  return (
    <div
      className={`terminal-surface ${standalone ? "terminal-direct" : ""}`}
      role="region"
      aria-label="Terminal"
    >
      {!standalone && (
        <div className="terminal-mode">
          <strong>{main ? "Project shell" : "Worktree shell"}</strong>
          <small>Interactive local shell · exclusive write access</small>
          {session && <Button onClick={close}>Close shell</Button>}
        </div>
      )}
      {standalone && session && (
        <button
          className="icon-button terminal-close"
          aria-label="Close terminal"
          title="Close terminal"
          onClick={close}
        >
          <X size={15} />
        </button>
      )}
      {error && <div className="notice error">{error}</div>}
      {session ? (
        <div className="terminal-host" ref={host} />
      ) : standalone ? (
        <div className="terminal-direct-status">
          {opening ? (
            <Loader2 size={16} className="spin" aria-label="Opening terminal" />
          ) : closed || error ? (
            <Button onClick={open}>
              {closed ? "Reopen terminal" : "Retry"}
            </Button>
          ) : null}
        </div>
      ) : (
        <Empty
          icon={TerminalIcon}
          title={
            main
              ? "Open a terminal in this project"
              : "Take the worktree controls"
          }
        >
          This is a real shell, not recorded command output. Opening it
          invalidates checks and prevents Codex from writing at the same time.
          It runs as your local user, outside the Codex sandbox.
          {main &&
            " Commands can change your original project files. Other applications are not locked by Fleet."}
          <Button
            disabled={
              opening ||
              !run.worktree ||
              [
                "running",
                "preparing",
                "pausing",
                "validating",
                "accepting",
                "queued",
                "accepted",
              ].includes(run.status)
            }
            onClick={open}
          >
            {opening
              ? "Opening…"
              : main
                ? "Open project shell"
                : "Open worktree shell"}
          </Button>
        </Empty>
      )}
    </div>
  );
}
