import React, { useState } from "react";
import { Dialog, Field, Button } from "../ui.jsx";
import { ProjectDialog } from "./dialogs.jsx";

export function ProjectStart(props) {
  const [idea, setIdea] = useState("");
  const [mode, setMode] = useState("create");
  const [step, setStep] = useState("idea");
  if (step === "folder")
    return (
      <ProjectDialog
        {...props}
        initialMode={mode}
        idea={idea.trim()}
        onBack={() => setStep("idea")}
      />
    );
  return (
    <Dialog
      title="What do you want to build?"
      subtitle="Start with the outcome. You can choose the technical details as you go."
      onClose={props.onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setStep("folder");
        }}
      >
        <Field
          label="Your idea"
          hint="Optional for now. Add a first task to go straight from setup into building."
        >
          <textarea
            autoFocus
            rows={5}
            maxLength={28000}
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            placeholder="A simple place to track customer feedback, with search and a clear weekly summary…"
          />
        </Field>
        <div className="project-choice">
          <Button
            type="button"
            aria-pressed={mode === "create"}
            primary={mode === "create"}
            onClick={() => setMode("create")}
          >
            Start fresh
          </Button>
          <Button
            type="button"
            aria-pressed={mode === "open"}
            primary={mode === "open"}
            onClick={() => setMode("open")}
          >
            Use an existing folder
          </Button>
        </div>
        <p className="muted-copy">
          Nothing runs until you confirm the folder and first task. Your
          existing Codex account is used.
        </p>
        <div className="dialog-actions">
          <Button type="button" onClick={props.onClose}>
            Cancel
          </Button>
          <Button primary type="submit">
            Choose folder
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function SnapshotSelection({ snapshot, onChange }) {
  const eligible = snapshot.files.filter((f) => !f.excluded);
  return (
    <section className="snapshot-selection">
      <h3>Review starting files</h3>
      <p className="muted-copy">
        Fleet creates a local working copy from these files. Originals and Git
        history stay untouched. Excluded files never enter the copy. Text files
        only; checks cannot guarantee all secrets are detected.
      </p>
      <div className="snapshot-files">
        {snapshot.files.map((file) => (
          <label key={file.path} className="snapshot-file">
            <input
              type="checkbox"
              disabled={!!file.excluded}
              checked={snapshot.selected.includes(file.path)}
              onChange={(e) =>
                onChange({
                  ...snapshot,
                  approved: false,
                  selected: e.target.checked
                    ? [...snapshot.selected, file.path]
                    : snapshot.selected.filter((p) => p !== file.path),
                })
              }
            />
            <span>
              <code>{file.path}</code>
              {file.excluded && <small>{file.excluded}</small>}
            </span>
          </label>
        ))}
      </div>
      <p className="muted-copy">
        {snapshot.selected.length} selected ·{" "}
        {snapshot.files.length - eligible.length} excluded
      </p>
      <label className="check-label">
        <input
          type="checkbox"
          required
          checked={snapshot.approved}
          onChange={(e) =>
            onChange({ ...snapshot, approved: e.target.checked })
          }
        />
        Approve a working copy containing only these selected files
      </label>
    </section>
  );
}
