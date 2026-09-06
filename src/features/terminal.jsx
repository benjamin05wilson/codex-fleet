import React, { useEffect, useRef, useState } from "react";
import { api, Button, Empty } from "../ui.jsx";
import { Terminal as TerminalIcon } from "lucide-react";
import "@xterm/xterm/css/xterm.css";

export function TerminalView({ run, act }) {
  const host = useRef(null);
  const [session, setSession] = useState(null);
  const [error, setError] = useState("");
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
      fit.fit();
      const send = (action, data) =>
        api(`/runs/${run.id}/terminal/${action}`, "POST", {
          ...data,
          lease: session.lease,
        }).catch((e) => setError(e.message));
      terminal.onData((data) => send("input", { data }));
      terminal.onResize(({ cols, rows }) => send("resize", { cols, rows }));
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
      events = setInterval(load, 200);
    })().catch((e) => setError(e.message));
    return () => {
      disposed = true;
      clearInterval(events);
      observer?.disconnect();
      terminal?.dispose();
    };
  }, [session, run.id]);
  return (
    <div className="terminal-surface">
      <div className="terminal-mode">
        <strong>Worktree shell</strong>
        <small>Interactive local shell · exclusive write access</small>
        {session && (
          <Button
            onClick={async () => {
              const r = await act(() =>
                api(`/runs/${run.id}/terminal/close`, "POST", {
                  lease: session.lease,
                }),
              );
              if (r) {
                setSession(null);
                setError("");
              }
            }}
          >
            Close shell
          </Button>
        )}
      </div>
      {error && <div className="notice error">{error}</div>}
      {session ? (
        <div className="terminal-host" ref={host} />
      ) : (
        <Empty icon={TerminalIcon} title="Take the worktree controls">
          This is a real shell, not recorded command output. Opening it
          invalidates checks and prevents Codex from writing at the same time.
          It runs as your local user.
          <Button
            disabled={
              !run.worktree ||
              [
                "running",
                "preparing",
                "pausing",
                "validating",
                "accepting",
                "queued",
              ].includes(run.status)
            }
            onClick={async () => {
              const r = await act(() =>
                api(`/runs/${run.id}/terminal/open`, "POST", {}),
              );
              if (r) setSession(r);
            }}
          >
            Open worktree shell
          </Button>
        </Empty>
      )}
    </div>
  );
}
