import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Check, RefreshCw } from "lucide-react";
import { api, Button, Mark } from "../ui.jsx";
import { validAuthURL } from "../../shared/auth.mjs";
import "../setup.css";

export function SignInGate({ initial, onReady, request = api }) {
  const [state, setState] = useState(
    initial || { checking: true, authenticated: false },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [authUrl, setAuthUrl] = useState("");
  const dialog = useRef(null),
    ready = useRef(initial?.authenticated && !initial?.sandboxRequired),
    callback = useRef(onReady);
  callback.current = onReady;
  useEffect(() => {
    let stopped = false,
      pending = false;
    const update = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await request("/auth/status");
        if (typeof next.authenticated !== "boolean")
          throw new Error("Invalid sign-in status");
        if (stopped) return;
        setState(next);
        if (next.authenticated && !next.sandboxRequired && !ready.current)
          callback.current?.();
        ready.current = next.authenticated && !next.sandboxRequired;
      } catch {
        if (!stopped) {
          setState({ available: false, authenticated: false });
          setError(
            "Unable to check Codex. Check the local connection and retry.",
          );
        }
      } finally {
        pending = false;
      }
    };
    const required = () => {
      ready.current = false;
      setState({ authenticated: false, available: true });
      update();
    };
    if (!initial?.authenticated) update();
    const timer = setInterval(update, 2500);
    window.addEventListener("fleet:sign-in-required", required);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("fleet:sign-in-required", required);
    };
  }, [request]);
  const sandbox = state.authenticated && state.sandboxRequired;
  const blocked = !state.authenticated || sandbox;
  useEffect(() => {
    if (blocked && dialog.current && !dialog.current.open) {
      if (dialog.current.showModal) dialog.current.showModal();
      else dialog.current.setAttribute("open", "");
    }
  }, [blocked]);
  if (!blocked) return null;
  const open = async (url) => {
    if (!validAuthURL(url))
      throw new Error("Invalid sign-in link. Please retry.");
    if (window.fleetDesktop?.openSignIn)
      await window.fleetDesktop.openSignIn(url);
    else window.open(url, "_blank", "noopener,noreferrer");
  };
  const login = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await request("/auth/login", "POST", {});
      if (next.authenticated) {
        setState(next);
        if (!next.sandboxRequired) callback.current?.();
        return;
      }
      setAuthUrl(next.authUrl);
      setState((s) => ({ ...s, waiting: true }));
      await open(next.authUrl);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <dialog
      ref={dialog}
      className="sign-in-gate"
      aria-label="Connect Codex"
      onCancel={(e) => e.preventDefault()}
    >
      <header className="setup-brand">
        <Mark />
        <span>Fleet</span>
      </header>
      <section className="sign-in-content">
        <span className="setup-eyebrow">YOUR WORKSPACE IS ALMOST READY</span>
        <h1>
          {sandbox
            ? "One Windows step left."
            : state.checking
              ? "Checking Codex…"
              : state.available === false
                ? "Let’s finish setup."
                : state.waiting
                  ? "Finish signing in."
                  : "Connect your Codex account."}
        </h1>
        <p className="setup-intro">
          {sandbox
            ? "Set up Codex’s protected coding environment. Windows will ask for administrator approval to create its sandbox accounts and firewall rules. Fleet will never switch to YOLO if you decline."
            : state.waiting
              ? "Complete sign-in in your browser. Fleet will continue here automatically."
              : "Sign in with ChatGPT to start coding. Your password stays with OpenAI, and your projects and drafts stay here."}
        </p>
        <div className="sign-in-check">
          <Check size={16} /> Local workspace ready
        </div>
        <div className="sign-in-check">
          <Check size={16} />{" "}
          {state.available === false
            ? "Codex needs attention"
            : "Codex installed"}
        </div>
        {(error || state.error) && (
          <p role="alert" className="sign-in-error">
            {error || state.error}
          </p>
        )}
        <div className="sign-in-actions">
          {sandbox ? (
            <Button
              primary
              disabled={busy || state.sandboxBusy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  setState(
                    await request("/auth/windows-setup", "POST", {
                      approved: true,
                    }),
                  );
                } catch (e) {
                  setError(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {state.sandboxBusy
                ? "Waiting for Windows setup…"
                : "Set up Windows sandbox"}
            </Button>
          ) : (
            state.available !== false &&
            !state.checking && (
              <Button
                primary
                icon={ArrowUpRight}
                disabled={busy}
                onClick={login}
              >
                {busy
                  ? "Opening sign-in…"
                  : state.waiting
                    ? "Open sign-in again"
                    : "Sign in with ChatGPT"}
              </Button>
            )
          )}
          <Button
            icon={RefreshCw}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const next = await request("/auth/refresh", "POST", {});
                setState(next);
                if (next.authenticated && !next.sandboxRequired)
                  callback.current?.();
              } catch (e) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Check again
          </Button>
          {state.waiting && (
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await request("/auth/cancel", "POST", {});
                  setAuthUrl("");
                  setState((s) => ({ ...s, waiting: false }));
                } catch (e) {
                  setError(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Cancel sign-in
            </Button>
          )}
        </div>
        {authUrl && validAuthURL(authUrl) && (
          <p className="setup-footnote">
            <a
              href={authUrl}
              target="_blank"
              rel="noreferrer"
              onClick={
                window.fleetDesktop?.openSignIn
                  ? (e) => {
                      e.preventDefault();
                      open(authUrl).catch((e) => setError(e.message));
                    }
                  : undefined
              }
            >
              Browser didn’t open? Open the sign-in page.
            </a>
          </p>
        )}
        <p className="setup-footnote">
          Already signed in through the Codex CLI? Choose “Check again”. No
          terminal commands are required for a new sign-in.
        </p>
      </section>
    </dialog>,
    document.body,
  );
}
