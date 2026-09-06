import React, { useEffect, useRef, useState } from "react";
import {
  GitBranch,
  MessageSquare,
  Plus,
  Terminal,
  Trash2,
  RotateCcw,
} from "lucide-react";
import { deletionBlockedReason } from "../../shared/session-lifecycle.mjs";
import { Button, Dialog, Field, Status, api } from "../ui.jsx";
import { useCodexMetadata } from "./codex-metadata.jsx";
import { codingDefault, yoloWarning } from "../../shared/permissions.mjs";

export function SessionOptions({ run, act, onClose }) {
  const [sandbox, setSandbox] = useState(run.sandbox);
  const [model, setModel] = useState(run.model || "");
  const [remember, setRemember] = useState(false);
  const [saving, setSaving] = useState(false);
  const [yoloApproved, setYoloApproved] = useState(
    run.sandbox === "danger-full-access" && run.yoloApproved === true,
  );
  const metadata = useCodexMetadata();
  return (
    <Dialog title="Conversation settings" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          try {
            const result = await act(() =>
              api(`/runs/${run.id}/options`, "POST", {
                sandbox,
                model,
                rememberDefaults: remember,
                approved: true,
                yoloApproved,
              }),
            );
            if (result) onClose();
          } finally {
            setSaving(false);
          }
        }}
      >
        <fieldset className="quick-fields" disabled={saving}>
          <Field label="Permissions">
            <select
              value={sandbox}
              onChange={(e) => setSandbox(e.target.value)}
            >
              <option value="read-only">Read only</option>
              <option value="workspace-write">
                Allow edits in the working folder
              </option>
              {!run.teamId && !run.teamRole && !run.missionId && (
                <option value="danger-full-access">YOLO · full access</option>
              )}
            </select>
          </Field>
          <p className="muted-copy">
            {sandbox === "danger-full-access"
              ? yoloWarning
              : sandbox === "read-only"
                ? "Codex can inspect files without changing them."
                : run.workspaceKind === "main"
                  ? "Codex can edit your project's original folder, including existing uncommitted files. Changes are not isolated."
                  : "Codex can edit its isolated working folder. Your source folder stays untouched."}{" "}
            {sandbox !== "danger-full-access" &&
              "No unattended permission escalation."}
          </p>
          {sandbox === "danger-full-access" && (
            <label className="check-label">
              <input
                type="checkbox"
                required
                checked={yoloApproved}
                onChange={(e) => setYoloApproved(e.target.checked)}
              />
              I understand and approve full-access YOLO permissions.
            </label>
          )}
          <Field
            label="Model"
            hint="Blank uses the installed default. You can select a discovered model or enter its name."
          >
            <input
              list={`models-${run.id}`}
              value={model}
              maxLength={150}
              onChange={(e) => setModel(e.target.value)}
              placeholder="Installed default"
            />
            <datalist id={`models-${run.id}`}>
              {metadata.data?.models.map((m) => (
                <option key={m.model} value={m.model}>
                  {m.displayName || m.model}
                </option>
              ))}
            </datalist>
          </Field>
          {metadata.error && (
            <p className="muted-copy">
              Model discovery unavailable. Manual entry still works.
            </p>
          )}
          <label className="check-label">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            Use these settings for new conversations in this workspace
          </label>
          <div className="dialog-actions">
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button primary type="submit" disabled={saving}>
              {saving ? "Saving…" : "Apply settings"}
            </Button>
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}

export function QuickSession({
  state,
  projectId,
  onClose,
  onCreated,
  onAdd,
  onGuided,
  act,
}) {
  const [target, setTarget] = useState(
    state.projects.find((p) => p.id === projectId && p.kind !== "scratch")
      ?.id || "",
  );
  const [query, setQuery] = useState("");
  const [prompt, setPrompt] = useState(
    () => localStorage.getItem(`fleet.quick.${target || "scratch"}`) || "",
  );
  useEffect(() => {
    localStorage.setItem(`fleet.quick.${target || "scratch"}`, prompt);
  }, [target, prompt]);
  const project = state.projects.find((p) => p.id === target);
  const saved =
    project?.sessionDefaults || (!target ? state.scratchDefaults : null) || {};
  const [sandbox, setSandbox] = useState(saved.sandbox || codingDefault);
  const [model, setModel] = useState(saved.model || "");
  const [useTeam, setUseTeam] = useState(saved.useTeam ?? false);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const team = state.teams?.find((t) => t.projectId === target && t.enabled);
  const choose = (id) => {
    setTarget(id);
    setPrompt(localStorage.getItem(`fleet.quick.${id || "scratch"}`) || "");
    const defaults =
      state.projects.find((p) => p.id === id)?.sessionDefaults ||
      (!id ? state.scratchDefaults : null) ||
      {};
    setSandbox(defaults.sandbox || codingDefault);
    setModel(defaults.model || "");
    setUseTeam(defaults.useTeam ?? false);
    setRemember(false);
  };
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const run = await act(() =>
        api("/sessions/quick", "POST", {
          projectId: target || null,
          prompt,
          sandbox,
          model,
          useTeam: !!team && useTeam && !!prompt.trim(),
          rememberDefaults: remember,
          approved: true,
        }),
      );
      if (run) {
        localStorage.removeItem(`fleet.quick.${target || "scratch"}`);
        onCreated(run);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="New session"
      subtitle="Pick a workspace and start. No build plan required."
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <fieldset className="quick-fields" disabled={busy}>
          <Field label="Find a project">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects…"
            />
          </Field>
          <div className="quick-projects" role="group" aria-label="Workspace">
            <button
              type="button"
              aria-pressed={!target}
              onClick={() => choose("")}
            >
              <strong>Scratch space</strong>
              <small>Private local folder · no project setup</small>
            </button>
            {state.projects
              .filter(
                (p) =>
                  !p.example &&
                  p.kind !== "scratch" &&
                  (p.name + p.path).toLowerCase().includes(query.toLowerCase()),
              )
              .map((p) => (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={target === p.id}
                  onClick={() => choose(p.id)}
                >
                  <strong>{p.name}</strong>
                  <small>{p.path}</small>
                </button>
              ))}
          </div>
          <Field
            label="Instruction"
            hint="Optional. Leave blank to open a conversation without making a model call."
          >
            <textarea
              rows={3}
              maxLength={30000}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What do you want to work on?"
            />
          </Field>
          <div
            className="quick-permissions"
            role="group"
            aria-label="Session permissions"
          >
            <Button
              type="button"
              aria-pressed={sandbox === "read-only"}
              onClick={() => setSandbox("read-only")}
            >
              Read only
            </Button>
            <Button
              type="button"
              aria-pressed={sandbox === "workspace-write"}
              onClick={() => setSandbox("workspace-write")}
            >
              Allow edits
            </Button>
          </div>
          <p className="muted-copy">
            {sandbox === "read-only"
              ? "Codex can inspect files without changing them."
              : "Codex can edit its isolated working folder."}{" "}
            Sending an instruction uses your Codex allowance.
          </p>
          <details className="quick-options">
            <summary>Session options</summary>
            <Field label="Model" hint="Blank uses the installed default.">
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Installed default"
              />
            </Field>
            {team && (
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={useTeam && !!prompt.trim()}
                  disabled={!prompt.trim()}
                  onChange={(e) => setUseTeam(e.target.checked)}
                />
                Continue with the project’s Developer (requires an instruction)
              </label>
            )}
            <label className="check-label">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              Remember these settings for {project?.name || "scratch sessions"}
            </label>
          </details>
          <div className="dialog-actions">
            <Button type="button" onClick={onAdd}>
              Add folder
            </Button>
            <Button type="button" onClick={onGuided}>
              Guided build
            </Button>
            <Button primary disabled={busy} type="submit">
              {busy
                ? "Opening…"
                : prompt.trim()
                  ? team && useTeam
                    ? "Assign to Developer"
                    : "Start session"
                  : "Open conversation"}
            </Button>
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}

export function NewWorkspaceMenu({ project, onNew, busy, compact = false }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({});
  const root = useRef(null);
  const trigger = useRef(null);
  useEffect(() => {
    if (!open) return;
    const rect = trigger.current.getBoundingClientRect();
    setPosition({
      left: Math.max(12, Math.min(rect.left, window.innerWidth - 292)),
      top: Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - 222)),
    });
    root.current?.querySelector(".new-workspace-options button")?.focus();
    const close = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      } else if (
        event.type === "pointerdown" &&
        !root.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("pointerdown", close);
    };
  }, [open]);
  return (
    <div
      className={`new-workspace-menu ${compact ? "compact" : ""}`}
      ref={root}
    >
      <button
        ref={trigger}
        className={compact ? "icon-button" : "button"}
        aria-label={
          compact
            ? `New item in ${project?.name || "workspace"}`
            : "New workspace item"
        }
        aria-expanded={open}
        disabled={busy || !project}
        onClick={() => setOpen(!open)}
      >
        <Plus size={15} />
        {!compact && "New"}
      </button>
      {open && (
        <div
          className="new-workspace-options"
          style={position}
          role="group"
          aria-label={`Create in ${project.name}`}
        >
          <div className="new-workspace-context">{project.name}</div>
          {[
            [
              "worktree",
              GitBranch,
              "New Git worktree",
              "Isolated branch · starts from committed HEAD",
            ],
            [
              "main",
              MessageSquare,
              "New main chat",
              "Project folder · uses your chat defaults",
            ],
            [
              "terminal",
              Terminal,
              "New terminal",
              "Project folder · local shell",
            ],
          ].map(([kind, Icon, title, hint]) => (
            <button
              key={kind}
              disabled={busy}
              onClick={() => {
                setOpen(false);
                onNew(project.id, kind);
              }}
            >
              <Icon size={16} />
              <span>
                <strong>{title}</strong>
                <small>{hint}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function WorkspaceSidebar({
  state,
  allProjects = false,
  projectId,
  selected,
  showExamples,
  goRun,
  chooseProject,
  onNew,
  onDelete,
  onTrash,
  trashCount = 0,
  busy,
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState({});
  const projects = state.projects.filter(
    (p) => (allProjects || p.id === projectId) && (!p.example || showExamples),
  );
  const groups = [
    ...projects
      .filter((p) => p.kind !== "scratch")
      .map((p) => ({ id: p.id, name: p.name, projects: [p.id] })),
    ...(projects.some((p) => p.kind === "scratch")
      ? [
          {
            id: "scratch",
            name: "Scratch",
            projects: projects
              .filter((p) => p.kind === "scratch")
              .map((p) => p.id),
          },
        ]
      : []),
  ];
  return (
    <section
      className="session-column project-sidebar"
      aria-label="Projects and sessions"
    >
      <div className="sidebar-actions">
        <NewWorkspaceMenu
          project={state.projects.find((p) => p.id === projectId)}
          onNew={onNew}
          busy={busy}
        />
      </div>
      <input
        className="sidebar-search"
        aria-label="Filter projects and sessions"
        placeholder="Find a conversation…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="project-groups">
        {groups.map((group) => {
          const runs = state.runs.filter(
            (r) =>
              group.projects.includes(r.projectId) &&
              !r.reviewOf &&
              (!r.teamRole || r.teamRole === "developer"),
          );
          const visible = runs.filter((r) =>
            (group.name + " " + r.title)
              .toLowerCase()
              .includes(query.toLowerCase()),
          );
          if (
            query &&
            !visible.length &&
            !group.name.toLowerCase().includes(query.toLowerCase())
          )
            return null;
          return (
            <section key={group.id} className="project-group">
              <div className="project-group-heading">
                <button
                  className="project-collapse"
                  aria-label={`${collapsed[group.id] ? "Expand" : "Collapse"} ${group.name}`}
                  aria-expanded={!collapsed[group.id]}
                  onClick={() => {
                    setCollapsed({
                      ...collapsed,
                      [group.id]: !collapsed[group.id],
                    });
                  }}
                >
                  <span>{collapsed[group.id] ? "▸" : "▾"}</span>
                </button>
                <button
                  className="project-name"
                  title={
                    state.projects.find((p) => p.id === group.projects[0])
                      ?.path || group.name
                  }
                  onClick={() => chooseProject(group.projects[0])}
                >
                  {group.name}
                </button>
                <NewWorkspaceMenu
                  compact
                  project={state.projects.find(
                    (p) => p.id === group.projects[0],
                  )}
                  onNew={onNew}
                  busy={busy}
                />
              </div>
              {(!collapsed[group.id] || query) &&
                visible.map((run) => (
                  <div className="session-entry" key={run.id}>
                    <button
                      className={`session-row ${selected === run.id ? "selected" : ""}`}
                      aria-current={selected === run.id ? "page" : undefined}
                      onClick={() => goRun(run.id)}
                    >
                      {run.sessionKind === "terminal" ? (
                        <Terminal size={14} />
                      ) : run.sessionKind === "worktree" ? (
                        <GitBranch size={14} />
                      ) : run.sessionKind === "main" ? (
                        <MessageSquare size={14} />
                      ) : (
                        <Status status={run.status} short />
                      )}
                      <div className="session-row-label">
                        <strong>{run.title}</strong>
                        <span>
                          {run.sessionKind === "terminal"
                            ? run.shellOpen
                              ? "Shell open"
                              : "Local shell"
                            : run.blockedReason ||
                              (run.waitingForTask
                                ? ""
                                : run.status === "running"
                                  ? "Working"
                                  : run.status === "review"
                                    ? run.files?.length
                                      ? `${run.files.length} ${run.files.length === 1 ? "file" : "files"} changed`
                                      : ""
                                    : run.status)}
                        </span>
                      </div>
                    </button>
                    {onDelete && (
                      <span
                        className="session-delete-action"
                        title={deletionBlockedReason(run) || "Move to Trash"}
                      >
                        <button
                          className="icon-button"
                          aria-label={`Delete ${run.sessionKind === "terminal" ? "terminal" : "chat"}: ${run.title}`}
                          disabled={busy || !!deletionBlockedReason(run)}
                          onClick={() => onDelete(run)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </span>
                    )}
                  </div>
                ))}
              {!collapsed[group.id] && !runs.length && (
                <button
                  className="sidebar-empty"
                  disabled={busy}
                  onClick={() => onNew(group.projects[0])}
                >
                  Start a conversation
                </button>
              )}
            </section>
          );
        })}
        {!groups.length && (
          <p className="sidebar-empty">
            Add a folder or start in scratch space.
          </p>
        )}
      </div>
      {onTrash && (
        <button className="sidebar-trash" onClick={onTrash}>
          <Trash2 size={14} />
          Trash{trashCount > 0 && <span>{trashCount}</span>}
        </button>
      )}
    </section>
  );
}

export function DeleteSessionDialog({ run, onClose, onDelete, busy }) {
  const label = run.sessionKind === "terminal" ? "terminal" : "chat";
  const reason = deletionBlockedReason(run);
  return (
    <Dialog title={`Delete ${label}?`} onClose={onClose}>
      <p className="delete-session-copy">
        Move <strong>{run.title}</strong> to Trash? You can restore it later.
        Chat history, project files and Git worktrees are kept.
      </p>
      {reason && <p className="notice">{reason}</p>}
      <div className="dialog-actions">
        <Button autoFocus disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={busy || !!reason} onClick={onDelete}>
          Delete {label}
        </Button>
      </div>
    </Dialog>
  );
}

export function SessionTrash({ runs, projects, busy, onRestore, onClose }) {
  return (
    <Dialog
      title="Trash"
      subtitle="Deleted chats stay here until you restore them. Their history and files are kept."
      onClose={onClose}
    >
      <div className="session-trash-list">
        {!runs.length && <p className="muted-copy">Trash is empty.</p>}
        {runs.map((run) => (
          <div className="session-trash-row" key={run.id}>
            <div>
              <strong>{run.title}</strong>
              <small>
                {projects.find((p) => p.id === run.projectId)?.name ||
                  "Project"}
              </small>
            </div>
            <Button
              icon={RotateCcw}
              aria-label={`Restore: ${run.title}`}
              disabled={busy}
              onClick={() => onRestore(run.id)}
            >
              Restore
            </Button>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

export function SessionFiles({ run }) {
  const [files, setFiles] = useState(null),
    [path, setPath] = useState(""),
    [content, setContent] = useState(null),
    [error, setError] = useState(""),
    [query, setQuery] = useState("");
  useEffect(() => {
    let alive = true;
    api(`/runs/${run.id}/files`)
      .then((v) => {
        if (alive) {
          setFiles(v);
          setError("");
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [run.id, run.worktree, run.updatedAt]);
  useEffect(() => {
    let alive = true;
    setContent(null);
    if (path)
      api(`/runs/${run.id}/files?path=${encodeURIComponent(path)}`)
        .then((v) => {
          if (alive) setContent(v.content);
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    return () => {
      alive = false;
    };
  }, [run.id, path, run.updatedAt]);
  return (
    <section className="session-files">
      <p className="muted-copy">
        Read-only files from this session’s working folder. Sensitive paths are
        excluded.
      </p>
      {error && <p role="alert">{error}</p>}
      <input
        aria-label="Find a file"
        placeholder="Find a file…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="file-paths">
        {files?.files
          .filter((f) => f.toLowerCase().includes(query.toLowerCase()))
          .map((file) => (
            <button
              key={file}
              className={file === path ? "selected" : ""}
              onClick={() => {
                setPath(file);
                setError("");
              }}
            >
              {file}
            </button>
          ))}
      </div>
      {files?.pending && (
        <p>The working folder is created when this conversation starts.</p>
      )}
      {files && !files.pending && !files.files.length && <p>No files yet.</p>}
      {files?.truncated && <p>Showing the first 1,500 files.</p>}
      {path && (
        <>
          <h4>{path}</h4>
          <pre>{content ?? "Loading file…"}</pre>
        </>
      )}
    </section>
  );
}
