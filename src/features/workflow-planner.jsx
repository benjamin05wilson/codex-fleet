import React, { useState, useEffect } from "react";
import { Plus, Play, CheckCheck, ArrowRight } from "lucide-react";
import { api, Button, Dialog, Field, Empty } from "../ui.jsx";
export function WorkflowPlanner({
  project,
  state,
  act,
  goRun,
  openRequest,
  onOpenHandled,
}) {
  const templates = state.workflowTemplates || [];
  const limits = state.limits;
  const fromTemplate = (t) =>
    (t?.tasks || []).map((task) => ({
      ...task,
      scopes: (task.scopes || []).join(", "),
      sequential: false,
    }));
  const [open, setOpen] = useState(false),
    [templateId, setTemplate] = useState(templates[0]?.id || ""),
    [title, setTitle] = useState(""),
    [objective, setObjective] = useState(""),
    [tasks, setTasks] = useState(() => fromTemplate(templates[0]));
  const workflows = (state.workflows || []).filter(
    (w) => w.projectId === project.id,
  );
  useEffect(() => {
    if (openRequest) {
      setOpen(true);
      onOpenHandled();
    }
  }, [openRequest, onOpenHandled]);
  const change = (i, key, value) =>
    setTasks(
      tasks.map((t, index) => (index === i ? { ...t, [key]: value } : t)),
    );
  return (
    <div className="workflow-page">
      <div className="workflow-actions">
        <Button
          icon={Plus}
          disabled={!limits || !templates.length}
          onClick={() => setOpen(true)}
        >
          Plan a workflow
        </Button>
        <span>
          {limits
            ? `Up to ${limits.tasks} tasks · ${limits.concurrency} parallel · ${limits.attempts - 1} corrective retry`
            : "Waiting for daemon capabilities…"}
        </span>
      </div>
      {!workflows.length && (
        <Empty icon={CheckCheck} title="Start with a plan">
          Define the outcome, inspect the tasks and approve their limits. Fleet
          will stop for your final review.
        </Empty>
      )}
      {workflows.map((w) => (
        <section className="workflow-item" key={w.id}>
          <div className="workflow-title">
            <h2>{w.title}</h2>
            <span className="pill">{w.status.replaceAll("-", " ")}</span>
          </div>
          <p>{w.objective}</p>
          <p className="muted-copy">
            {w.reason ||
              `Approved limits: ${w.limits.concurrency} parallel · ${w.limits.maxAttempts} attempts per task · ${Math.round(w.limits.timeoutMs / 60000)} minutes per attempt`}
          </p>
          <ol>
            {w.tasks.map((t, i) => (
              <li key={i}>
                <strong>{t.title}</strong>
                <p>{t.prompt}</p>
                <small>
                  Scope: {t.scopes.join(", ") || "entire repository"}
                  {t.dependencies.length
                    ? ` · after task ${t.dependencies.map((d) => d + 1).join(", ")}`
                    : ""}
                </small>
                {w.runIds?.[i] && (
                  <Button onClick={() => goRun(w.runIds[i])} icon={ArrowRight}>
                    Open session
                  </Button>
                )}
              </li>
            ))}
          </ol>
          {(!w.approvedAt || w.trashPause) && (
            <Button
              primary
              icon={Play}
              onClick={() =>
                act(
                  () => api(`/workflows/${w.id}/approve`, "POST", {}),
                  "Plan approved. Tasks are queued within the displayed limits.",
                )
              }
            >
              {w.trashPause ? "Resume workflow" : "Approve plan & run"}
            </Button>
          )}
        </section>
      ))}
      {open && (
        <Dialog title="Plan a workflow" onClose={() => setOpen(false)} wide>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const result = await act(() =>
                api(`/projects/${project.id}/workflows`, "POST", {
                  templateId,
                  title,
                  objective,
                  tasks: tasks.map((t, i) => ({
                    ...t,
                    scopes: t.scopes
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                    dependencies: t.sequential && i > 0 ? [i - 1] : [],
                  })),
                }),
              );
              if (result) setOpen(false);
            }}
          >
            <div className="dialog-body">
              <Field label="Template">
                <select
                  value={templateId}
                  onChange={(e) => {
                    const t = templates.find((t) => t.id === e.target.value);
                    setTemplate(t.id);
                    setTasks(fromTemplate(t));
                  }}
                >
                  {templates.map((t) => (
                    <option value={t.id} key={t.id}>
                      {t.title}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Plan title">
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  maxLength={160}
                />
              </Field>
              <Field label="Outcome">
                <textarea
                  value={objective}
                  onChange={(e) => setObjective(e.target.value)}
                  required
                  rows={3}
                />
              </Field>
              {tasks.map((t, i) => (
                <fieldset className="workflow-task" key={i}>
                  <legend>Task {i + 1}</legend>
                  <Field label="Task title">
                    <input
                      value={t.title}
                      onChange={(e) => change(i, "title", e.target.value)}
                      required
                    />
                  </Field>
                  <Field label="Instruction">
                    <textarea
                      value={t.prompt}
                      onChange={(e) => change(i, "prompt", e.target.value)}
                      required
                      rows={3}
                    />
                  </Field>
                  <Field
                    label="File scope"
                    hint="Comma-separated relative paths. Empty means the entire repository."
                  >
                    <input
                      value={t.scopes}
                      onChange={(e) => change(i, "scopes", e.target.value)}
                    />
                  </Field>
                  {i > 0 && (
                    <label>
                      <input
                        type="checkbox"
                        checked={t.sequential}
                        onChange={(e) =>
                          change(i, "sequential", e.target.checked)
                        }
                      />{" "}
                      Wait for the preceding task’s checks
                    </label>
                  )}
                  {tasks.length > 1 && (
                    <Button
                      onClick={() => setTasks(tasks.filter((_, n) => n !== i))}
                      type="button"
                    >
                      Remove task
                    </Button>
                  )}
                </fieldset>
              ))}
              {limits && tasks.length < limits.tasks && (
                <Button
                  type="button"
                  icon={Plus}
                  onClick={() =>
                    setTasks([
                      ...tasks,
                      { title: "", prompt: "", scopes: "", sequential: true },
                    ])
                  }
                >
                  Add task
                </Button>
              )}
              <p className="muted-copy">
                Saving does not execute anything. Inspect the saved plan before
                approval. Coding workflows require a project check command.
              </p>
            </div>
            <div className="dialog-foot">
              <Button type="button" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                primary
                type="submit"
                disabled={!limits || !tasks.length || !templateId}
              >
                Save plan for review
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}
