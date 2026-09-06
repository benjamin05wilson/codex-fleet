import React, { useEffect, useRef, useState } from "react";
import { useCodexMetadata } from "./codex-metadata.jsx";
import { TeamApproval, TeamSettings } from "./team.jsx";
import { SnapshotSelection } from "./onboarding.jsx";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUpRight,
  ArrowRight,
  ArrowLeft,
  Plus,
  Search,
  ChevronDown,
  ChevronRight,
  Folder,
  GitBranch,
  Circle,
  CircleCheck,
  CircleDot,
  Clock3,
  Square,
  Play,
  Pause,
  X,
  Command,
  Settings2,
  BookOpen,
  Shield,
  Activity,
  Layers,
  Terminal,
  FileCode2,
  FileText,
  ExternalLink,
  RefreshCw,
  Check,
  AlertTriangle,
  Copy,
  MoreHorizontal,
  Send,
  GitPullRequest,
  ListFilter,
  Link2,
  Loader2,
  Pencil,
  Eye,
  Network,
  PanelLeftClose,
  Trash2,
  CornerDownLeft,
  CheckCheck,
  ShieldCheck,
} from "lucide-react";

import {
  api,
  activeStatuses,
  fmt,
  time,
  date,
  duration,
  Status,
  Mark,
  Button,
  Empty,
  MD,
  Dialog,
  Field,
} from "../ui.jsx";
function ProjectDialog({
  onClose,
  onSave,
  busy,
  teamConfig,
  initialMode = "open",
  idea = "",
  onBack,
}) {
  const [mode, setMode] = useState(initialMode);
  const [startTask, setStartTask] = useState(!!idea);
  const [snapshot, setSnapshot] = useState(null);
  const [folderName, setFolderName] = useState("");
  const [gitApproved, setGitApproved] = useState(false);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [validation, setValidation] = useState("");
  const [team, setTeam] = useState({
    approved: false,
  });
  const [inspection, setInspection] = useState(null),
    [inspecting, setInspecting] = useState(false),
    [error, setError] = useState(null);
  const pathRef = useRef(path);
  pathRef.current = path;
  async function inspect(value = path) {
    setInspecting(true);
    setError(null);
    setInspection(null);
    try {
      const result = await api("/repository/inspect", "POST", { path: value });
      if (pathRef.current === value) setInspection(result);
    } catch (e) {
      if (pathRef.current === value) setError(e.message);
    } finally {
      setInspecting(false);
    }
  }
  return (
    <Dialog
      title="Add a project"
      subtitle="Start something new or bring an existing folder. No GitHub account required."
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (mode === "open" && !inspection) {
            await inspect();
            return;
          }
          onSave({
            ...(snapshot
              ? {
                  mode: "import",
                  path: snapshot.path,
                  snapshotApproved: snapshot.approved,
                  snapshotDigest: snapshot.digest,
                  selectedFiles: snapshot.selected,
                }
              : mode === "create"
                ? { mode: "create", parentPath: path, folderName, gitApproved }
                : {
                    path: inspection?.path || path,
                    ...(inspection?.kind === "folder" ||
                    inspection?.kind === "unborn"
                      ? { mode: "initialise", gitApproved }
                      : {}),
                  }),
            name,
            validation,
            ...(team.approved ? { team } : {}),
            ...(startTask && idea
              ? {
                  firstTask: {
                    approved: true,
                    prompt:
                      idea +
                      "\n\nBuild a focused first version. Document how to run it locally and which checks you actually ran. Leave code changes for review.",
                  },
                }
              : {}),
          });
        }}
      >
        <div
          className="repository-actions"
          role="group"
          aria-label="Project setup"
        >
          {[
            ["open", "Open existing folder"],
            ["create", "Create new project"],
          ].map(([value, label]) => (
            <Button
              key={value}
              type="button"
              primary={mode === value}
              aria-pressed={mode === value}
              onClick={() => {
                setMode(value);
                setPath("");
                setInspection(null);
                setError(null);
                setGitApproved(false);
                setSnapshot(null);
              }}
            >
              {label}
            </Button>
          ))}
        </div>
        <Field
          label={mode === "create" ? "Parent folder" : "Folder path"}
          hint={
            mode === "create"
              ? "Choose an existing location for your new project folder."
              : "Choose a folder or enter an absolute path. Checking it does not change any files."
          }
        >
          <input
            autoFocus
            required
            placeholder="/Users/you/projects/my-app"
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              setInspection(null);
              setError(null);
              setGitApproved(false);
              setSnapshot(null);
            }}
          />
        </Field>
        <div className="repository-actions">
          {window.fleetDesktop?.chooseRepository && (
            <Button
              type="button"
              icon={Folder}
              onClick={async () => {
                try {
                  const selected = await window.fleetDesktop.chooseRepository();
                  if (selected) {
                    setPath(selected);
                    pathRef.current = selected;
                    setInspection(null);
                    setGitApproved(false);
                    setSnapshot(null);
                    if (mode === "open") await inspect(selected);
                  }
                } catch (e) {
                  setError(e.message);
                }
              }}
            >
              Choose folder
            </Button>
          )}
          {mode === "open" && (
            <Button
              type="button"
              disabled={!path.trim() || inspecting}
              onClick={() => inspect()}
            >
              {inspecting ? "Inspecting…" : "Check folder"}
            </Button>
          )}
        </div>
        {mode === "create" && (
          <Field
            label="Folder name"
            hint="A new folder will be created here. Existing folders are never overwritten."
          >
            <input
              required
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              placeholder="my-project"
            />
          </Field>
        )}
        {error && <p role="alert">{error}</p>}
        {inspection && (
          <div className="repository-inspection">
            <strong>
              {inspection.name} ·{" "}
              {inspection.kind === "folder"
                ? "Not yet using Git"
                : inspection.kind === "unborn"
                  ? "No commits yet"
                  : inspection.branch}
            </strong>
            <p>
              {snapshot
                ? "Selected files will be committed only in Fleet’s separate working copy. Your original folder stays untouched."
                : inspection.kind === "folder" || inspection.kind === "unborn"
                  ? "Existing files and staged changes stay untouched. Commit the files you want agents to use before starting tasks; they will not appear in Fleet worktrees until then."
                  : inspection.dirty
                    ? "Uncommitted changes will stay in your source folder."
                    : "Source working tree is clean."}
            </p>
            {inspection.commands.map((c) => (
              <Button
                key={c.command}
                type="button"
                onClick={() => setValidation(c.command)}
              >
                Use {c.command}
              </Button>
            ))}
            {!!inspection.commands.length && (
              <p>
                Detected from package.json. Review the command before running
                checks.
              </p>
            )}
          </div>
        )}
        {inspection && mode === "open" && (
          <Button
            type="button"
            disabled={inspecting}
            onClick={async () => {
              setInspecting(true);
              setError(null);
              setSnapshot(null);
              const sourcePath = path;
              try {
                const result = await api("/repository/snapshot", "POST", {
                  path: sourcePath,
                });
                if (pathRef.current === sourcePath)
                  setSnapshot({
                    ...result,
                    selected: result.files
                      .filter((f) => !f.excluded)
                      .map((f) => f.path),
                    approved: false,
                  });
              } catch (e) {
                setError(e.message);
              } finally {
                setInspecting(false);
              }
            }}
          >
            {inspecting
              ? "Reviewing files…"
              : "Review files for a working copy"}
          </Button>
        )}
        {snapshot && (
          <SnapshotSelection snapshot={snapshot} onChange={setSnapshot} />
        )}
        {!snapshot &&
          (mode === "create" ||
            inspection?.kind === "folder" ||
            inspection?.kind === "unborn") && (
            <label className="check-label project-git-approval">
              <input
                type="checkbox"
                required
                checked={gitApproved}
                onChange={(e) => setGitApproved(e.target.checked)}
              />
              Initialise local Git with an empty starting commit. Do not add
              existing files or connect a remote.
            </label>
          )}
        <details className="project-advanced">
          <summary>
            Advanced options <span>Names, checks and agent team</span>
          </summary>
          <Field
            label="Display name"
            hint="Optional. Defaults to the folder name."
          >
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My project"
            />
          </Field>
          <Field
            label="Validation command"
            hint="Optional. Runs in the worktree sandbox when requested, or by an approved workflow."
          >
            <input
              className="mono-input"
              value={validation}
              onChange={(e) => setValidation(e.target.value)}
              placeholder="npm test"
            />
          </Field>
          <div className="form-note">
            <GitBranch size={16} />
            Fleet creates worktrees for sessions. Uncommitted source changes are
            not copied into them.
          </div>
          {teamConfig && (
            <TeamApproval config={teamConfig} value={team} onChange={setTeam} />
          )}
        </details>
        {idea && (
          <section className="first-task-summary">
            <h3>First task</h3>
            <p>{idea}</p>
            <label className="check-label">
              <input
                type="checkbox"
                checked={startTask}
                onChange={(e) => setStartTask(e.target.checked)}
              />
              Start building after setup. Allow Codex to edit its isolated
              worktree and use my account’s model allowance.
            </label>
          </section>
        )}
        <div className="dialog-actions">
          {onBack && (
            <Button type="button" onClick={onBack}>
              Back
            </Button>
          )}
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            primary
            type="submit"
            disabled={
              busy ||
              inspecting ||
              (snapshot && (!snapshot.approved || !snapshot.selected.length))
            }
          >
            {busy
              ? "Preparing…"
              : mode === "create"
                ? startTask && idea
                  ? "Create & build"
                  : "Create project"
                : !inspection
                  ? "Check folder first"
                  : startTask && idea
                    ? "Open & build"
                    : "Open project"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
function RunDialog({ project, onClose, onSave, busy, team }) {
  const codex = useCodexMetadata();
  const key = `fleet.new-session.${project.id || project.name}`;
  const [saved] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(key)) || {};
    } catch {
      return {};
    }
  });
  const [title, setTitle] = useState(saved.title || "");
  const [prompt, setPrompt] = useState(saved.prompt || "");
  const [sandbox, setSandbox] = useState(saved.sandbox || "read-only");
  const [scopes, setScopes] = useState(saved.scopes || "");
  const [model, setModel] = useState(saved.model || "");
  const [start, setStart] = useState(true);
  const [useTeam, setUseTeam] = useState(!!team?.enabled);
  useEffect(() => {
    localStorage.setItem(
      key,
      JSON.stringify({ title, prompt, sandbox, scopes, model }),
    );
  }, [key, title, prompt, sandbox, scopes, model]);
  return (
    <Dialog
      wide
      title="New session"
      subtitle={`Give Codex a focused task in ${project.name}.`}
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(
            {
              title,
              prompt,
              sandbox,
              scopes: scopes
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
              model,
              useTeam,
            },
            useTeam || start,
          );
        }}
      >
        <Field label="Session title">
          <input
            autoFocus
            required
            maxLength={160}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What are we working on?"
          />
        </Field>
        <Field label="Task">
          <textarea
            required
            rows={5}
            maxLength={30000}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe the outcome, constraints, and what a good result looks like…"
          />
        </Field>
        <div className="mode-options">
          <button
            type="button"
            className={sandbox === "read-only" ? "selected" : ""}
            onClick={() => setSandbox("read-only")}
          >
            <Eye size={18} />
            <strong>Explore</strong>
            <span>Read and investigate</span>
            {sandbox === "read-only" && <Check size={14} />}
          </button>
          <button
            type="button"
            className={sandbox === "workspace-write" ? "selected" : ""}
            onClick={() => setSandbox("workspace-write")}
          >
            <FileCode2 size={18} />
            <strong>Build</strong>
            <span>Edit in an isolated branch</span>
            {sandbox === "workspace-write" && <Check size={14} />}
          </button>
        </div>
        <details className="advanced">
          <summary>
            Context & model <ChevronDown size={13} />
          </summary>
          <Field
            label="Declared scope"
            hint="Comma-separated paths. Advisory; Sentinel flags changes outside this scope."
          >
            <input
              value={scopes}
              onChange={(e) => setScopes(e.target.value)}
              placeholder="src/auth, tests/auth"
            />
          </Field>
          <Field
            label="Model"
            hint="Leave blank to use the installed Codex default."
          >
            {codex.data ? (
              <select
                aria-label="Model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                <option value="">Installed Codex default</option>
                {model && !codex.data.models.some((m) => m.model === model) && (
                  <option value={model}>
                    {model} (saved; not in current catalogue)
                  </option>
                )}
                {codex.data.models.map((m) => (
                  <option key={m.model} value={m.model}>
                    {m.displayName}
                    {m.isDefault ? " · default" : ""}
                  </option>
                ))}
              </select>
            ) : (
              <input
                aria-label="Model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Installed Codex default"
              />
            )}
          </Field>
          {codex.loading && <small>Reading available models from Codex…</small>}
          {codex.error && (
            <p role="status">
              {codex.error} You can leave the model blank to use your installed
              configuration.
            </p>
          )}
          <Button type="button" disabled={codex.loading} onClick={codex.reload}>
            Refresh models
          </Button>
        </details>
        {team?.enabled && (
          <label className="check-label">
            <input
              type="checkbox"
              checked={useTeam}
              onChange={(e) => setUseTeam(e.target.checked)}
            />{" "}
            Assign to the persistent Developer session
          </label>
        )}
        {!useTeam && (
          <label className="check-label">
            <input
              type="checkbox"
              checked={start}
              onChange={(e) => setStart(e.target.checked)}
            />
            Start when created
          </label>
        )}
        <div className="dialog-actions">
          <span className="subtle-note">Project brain context included</span>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            primary
            type="submit"
            disabled={busy}
            icon={start ? Play : Plus}
          >
            {busy
              ? "Creating…"
              : useTeam
                ? "Start developer task"
                : start
                  ? "Start session"
                  : "Save draft"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
function MissionDialog({ onClose, onSave, busy }) {
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [tasks, setTasks] = useState([
    { title: "", prompt: "" },
    { title: "", prompt: "" },
  ]);
  const [sequential, setSequential] = useState(false);
  const [sandbox, setSandbox] = useState("read-only");
  return (
    <Dialog
      wide
      title="New mission"
      subtitle="Define the tasks yourself. Each gets an independent Codex session."
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ title, objective, tasks, sequential, sandbox });
        }}
      >
        <Field label="Mission">
          <input
            autoFocus
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="A clear, shared outcome"
          />
        </Field>
        <Field label="Objective & acceptance criteria">
          <textarea
            rows={3}
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            placeholder="What must be true when this mission is finished?"
          />
        </Field>
        <div className="task-editor-heading">
          <span>Tasks</span>
          <button
            type="button"
            className="text-button"
            disabled={tasks.length >= 12}
            onClick={() => setTasks([...tasks, { title: "", prompt: "" }])}
          >
            <Plus size={13} />
            Add task
          </button>
        </div>
        {tasks.map((t, i) => (
          <div className="task-editor" key={i}>
            <span>{String(i + 1).padStart(2, "0")}</span>
            <div>
              <input
                aria-label={`Task ${i + 1} title`}
                required
                placeholder="Task title"
                value={t.title}
                onChange={(e) =>
                  setTasks(
                    tasks.map((t, j) =>
                      j === i ? { ...t, title: e.target.value } : t,
                    ),
                  )
                }
              />
              <textarea
                aria-label={`Task ${i + 1} instruction`}
                required
                rows={2}
                placeholder="A focused instruction for this session"
                value={t.prompt}
                onChange={(e) =>
                  setTasks(
                    tasks.map((t, j) =>
                      j === i ? { ...t, prompt: e.target.value } : t,
                    ),
                  )
                }
              />
            </div>
            <button
              className="icon-button"
              type="button"
              aria-label={`Remove task ${i + 1}`}
              disabled={tasks.length <= 1}
              onClick={() => setTasks(tasks.filter((_, j) => j !== i))}
            >
              <X size={14} />
            </button>
          </div>
        ))}
        <div className="form-grid">
          <Field label="Execution">
            <select
              value={sequential ? "sequential" : "parallel"}
              onChange={(e) => setSequential(e.target.value === "sequential")}
            >
              <option value="parallel">Parallel — independent tasks</option>
              <option value="sequential">
                Sequential — accepted dependencies
              </option>
            </select>
          </Field>
          <Field label="Permissions">
            <select
              value={sandbox}
              onChange={(e) => setSandbox(e.target.value)}
            >
              <option value="read-only">Explore · read only</option>
              <option value="workspace-write">Build · workspace write</option>
            </select>
          </Field>
        </div>
        <div className="dialog-actions">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button primary type="submit" disabled={busy}>
            Create mission
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
function SettingsDialog({
  state,
  project,
  onClose,
  act,
  busy,
  showExamples,
  onShowExamples,
  onSetup,
}) {
  const codex = useCodexMetadata();
  const [name, setName] = useState(project?.name || "");
  const [validation, setValidation] = useState(project?.validation || "");
  return (
    <Dialog
      title="Workspace settings"
      subtitle="History and worktrees live on this machine. Codex connects to its model service."
      onClose={onClose}
    >
      <div className="settings-connection">
        <span
          className={
            "connection-dot " +
            (!state.status.authenticated ? "disconnected" : "")
          }
        />
        <div>
          <strong>{state.status.version || "Codex not found"}</strong>
          <p>{state.status.message}</p>
        </div>
      </div>
      {codex.data && (
        <p>
          {codex.data.accountType
            ? `Authentication: ${codex.data.accountType}`
            : "No account reported"}{" "}
          · {codex.data.models.length} available models
        </p>
      )}
      {codex.error && <p role="status">{codex.error}</p>}
      <Button onClick={codex.reload} disabled={codex.loading}>
        Refresh Codex connection
      </Button>
      {onSetup && <Button onClick={onSetup}>Setup & defaults…</Button>}
      {state.projects.some((p) => p.example) && (
        <label className="check-label">
          <input
            type="checkbox"
            checked={!!showExamples}
            onChange={(e) => onShowExamples?.(e.target.checked)}
          />{" "}
          Show existing example workspaces (history preserved)
        </label>
      )}
      {project && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const p = await act(
              () =>
                api(`/projects/${project.id}`, "PATCH", { name, validation }),
              "Project settings saved.",
            );
            if (p) onClose();
          }}
        >
          <Field label="Project name">
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field
            label="Validation command"
            hint="Runs in the worktree sandbox when requested, or automatically by an approved workflow."
          >
            <input
              className="mono-input"
              value={validation}
              onChange={(e) => setValidation(e.target.value)}
              placeholder="npm test"
            />
          </Field>
          <Field label="Repository">
            <code className="path-value">{project.path}</code>
          </Field>
          {project.sourcePath && (
            <Field
              label="Original folder"
              hint="This is an imported working copy. Changes are not automatically copied back to the original."
            >
              <code className="path-value">{project.sourcePath}</code>
            </Field>
          )}
          <Field label="Fleet data">
            <code className="path-value">{state.status.dataDir}</code>
          </Field>
          <div className="form-note">
            <Shield size={16} />
            {state.limits
              ? `${state.limits.concurrency} parallel sessions. ${Math.round(state.limits.timeoutMs / 60000)}-minute attempt timeout. `
              : ""}
            Workspace network disabled. No unattended approval escalation.
          </div>
          <div className="dialog-actions">
            <Button type="button" onClick={onClose}>
              Close
            </Button>
            <Button primary type="submit" disabled={busy}>
              Save settings
            </Button>
          </div>
        </form>
      )}
      {!project && (
        <div className="dialog-actions">
          <Button onClick={onClose}>Close</Button>
        </div>
      )}
      {project && (
        <TeamSettings project={project} state={state} act={act} busy={busy} />
      )}
    </Dialog>
  );
}
function SearchDialog({
  runs,
  onClose,
  goRun,
  navigate,
  onCreate,
  onResult,
  showExamples = false,
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      if (query.trim().length < 2) {
        setResults([]);
        return;
      }
      api(
        "/search?q=" +
          encodeURIComponent(query) +
          (showExamples ? "&includeExamples=1" : ""),
      )
        .then((items) => {
          if (alive) setResults(Array.isArray(items) ? items : []);
        })
        .catch(() => {});
    }, 180);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, showExamples]);
  return (
    <Dialog title="Jump to" onClose={onClose}>
      <div className="command-search">
        <Search size={18} />
        <input
          autoFocus
          aria-label="Search workspace"
          placeholder="Search sessions or go somewhere…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <kbd>esc</kbd>
      </div>
      <div className="command-results">
        {!query && (
          <>
            <button onClick={onCreate}>
              <Plus size={16} />
              <span>New session</span>
              <CornerDownLeft size={13} />
            </button>
            {[
              ["brain", BookOpen, "Project brain"],
              ["sentinel", Shield, "Sentinel"],
              ["missions", Layers, "Workflows"],
              ["attention", CircleDot, "Attention"],
              ["activity", Activity, "Activity"],
            ].map(([key, Icon, label]) => (
              <button key={key} onClick={() => navigate(key)}>
                <Icon size={16} />
                <span>{label}</span>
                <ArrowUpRight size={13} />
              </button>
            ))}
          </>
        )}
        {runs
          .filter(
            (r) =>
              r.title.toLowerCase().includes(query.toLowerCase()) ||
              results.some(
                (item) => item.kind === "session" && item.id === r.id,
              ),
          )
          .slice(0, 12)
          .map((r) => (
            <button key={r.id} onClick={() => goRun(r.id)}>
              <Terminal size={16} />
              <span>{r.title}</span>
              <Status status={r.status} short />
            </button>
          ))}
        {results
          .filter((r) => r.kind !== "session")
          .map((r, i) => (
            <button key={r.kind + i} onClick={() => onResult?.(r)}>
              <FileText size={16} />
              <span>{r.title}</span>
              <small>
                {r.kind}
                {r.stale ? " · stale" : ""}
              </small>
            </button>
          ))}
        {query &&
          !results.length &&
          !runs.some((r) =>
            r.title.toLowerCase().includes(query.toLowerCase()),
          ) && <p className="no-results">No results match “{query}”.</p>}
      </div>
    </Dialog>
  );
}

export {
  ProjectDialog,
  RunDialog,
  MissionDialog,
  SettingsDialog,
  SearchDialog,
};
