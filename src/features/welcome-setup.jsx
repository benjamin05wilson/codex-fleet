import React, { useState } from "react";
import { ArrowRight, ShieldCheck, Zap } from "lucide-react";
import { Button, Mark } from "../ui.jsx";
import {
  codingDefault,
  onboardingModes,
  yoloWarning,
} from "../../shared/permissions.mjs";
import "../setup.css";

export function WelcomeSetup({ saved, onSave, onSkip, busy }) {
  const [sandbox, setSandbox] = useState(
    saved?.sandbox === "danger-full-access" ? saved.sandbox : codingDefault,
  );
  const [yoloApproved, setYoloApproved] = useState(false);
  const yolo = sandbox === "danger-full-access";
  const ready = !busy && (!yolo || yoloApproved);
  const icons = [ShieldCheck, Zap];
  return (
    <main className="welcome-setup" aria-label="Fleet onboarding">
      <header className="setup-brand">
        <Mark />
        <span>Fleet</span>
        <button disabled={busy} onClick={onSkip}>
          {saved ? "Cancel" : "Set up later"}
        </button>
      </header>
      <div className="setup-content">
        <section>
          <span className="setup-eyebrow">ONE THING BEFORE YOU START</span>
          <h1>How much freedom should Codex have?</h1>
          <p className="setup-intro">
            Choose the default permissions for new chats. You can change them
            anytime; existing chats stay as they are.
          </p>
          <div
            className="setup-permissions"
            role="group"
            aria-label="Default permissions"
          >
            {onboardingModes.map((mode, index) => {
              const Icon = icons[index];
              return (
                <button
                  key={mode.id}
                  aria-pressed={sandbox === mode.id}
                  disabled={busy}
                  className={
                    mode.id === "danger-full-access" ? "yolo-choice" : ""
                  }
                  onClick={() => {
                    setSandbox(mode.id);
                    setYoloApproved(false);
                  }}
                >
                  <Icon size={20} />
                  <strong>{mode.title}</strong>
                  <span>{mode.summary}</span>
                  <small>
                    {index === 0
                      ? "Recommended · ready to code"
                      : "Explicit opt-in · elevated risk"}
                  </small>
                </button>
              );
            })}
          </div>
          {yolo ? (
            <div className="setup-warning">
              <strong>Full access means full responsibility.</strong>
              <p>{yoloWarning}</p>
              <label>
                <input
                  type="checkbox"
                  checked={yoloApproved}
                  onChange={(e) => setYoloApproved(e.target.checked)}
                  disabled={busy}
                />
                I understand the risks and want YOLO for new chats.
              </label>
            </div>
          ) : (
            <p className="setup-footnote">
              Standard keeps command network access off. Actions outside the
              sandbox fail instead of asking for extra access. Read-only is
              available in conversation settings; reviewers stay read-only.
              Local terminals are separate and run as your user.
            </p>
          )}
        </section>
        <footer className="setup-actions">
          <span>Stored locally · change in Settings anytime</span>
          <Button
            primary
            icon={ArrowRight}
            disabled={!ready}
            onClick={() =>
              onSave({
                sandbox,
                yoloApproved: yolo && yoloApproved,
                approved: true,
              })
            }
          >
            {busy
              ? "Saving…"
              : saved
                ? "Save permissions"
                : "Start using Fleet"}
          </Button>
        </footer>
      </div>
    </main>
  );
}
