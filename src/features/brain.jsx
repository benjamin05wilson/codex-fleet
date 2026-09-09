import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BrainGraph, noteTarget } from "./brain-graph.jsx";
import "../brain.css";
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
  PanelLeftOpen,
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
const NoteMarkdown = React.memo(MD);
const noteCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

// Reuse unchanged notes without serializing all Markdown on every refresh.
export function reconcileBrain(previous, next) {
  if (!previous) return next;
  const old = new Map(previous.notes.map((n) => [n.filename, n]));
  const notes = next.notes.map((n) => {
    const p = old.get(n.filename);
    return p &&
      Object.keys(p).length === Object.keys(n).length &&
      Object.keys(n).every((key) =>
        key === "links"
          ? n.links?.length === p.links?.length &&
            n.links?.every((v, i) => v === p.links[i])
          : n[key] === p[key] ||
            (n[key] &&
              typeof n[key] === "object" &&
              JSON.stringify(n[key]) === JSON.stringify(p[key])),
      )
      ? p
      : n;
  });
  const sameNotes =
    notes.length === previous.notes.length &&
    notes.every((n, i) => n === previous.notes[i]);
  const { notes: ignoredPrevious, ...oldMetadata } = previous;
  const { notes: ignoredNext, ...newMetadata } = next;
  if (sameNotes && JSON.stringify(oldMetadata) === JSON.stringify(newMetadata))
    return previous;
  return { ...next, notes: sameNotes ? previous.notes : notes };
}

function BrainView({
  project,
  act,
  state,
  notify,
  requestedNote,
  selectedRunId,
}) {
  const [data, setData] = useState(null);
  const [mode, setMode] = useState("graph");
  const [readerOpen, setReaderOpen] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [fileQuery, setFileQuery] = useState("");
  const selectedFile = useRef(null);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState("Home.md");
  useEffect(() => {
    if (requestedNote) {
      setSelected(requestedNote);
      setReaderOpen(true);
    }
  }, [requestedNote]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [newNote, setNewNote] = useState(false);
  const [noteTitle, setNoteTitle] = useState("");
  const [query, setQuery] = useState("");
  const [scopeView, setScopeView] = useState("project");
  const [worktreeScope, setWorktreeScope] = useState("");
  const selectedRun = state.runs.find((r) => r.id === selectedRunId);
  const worktreeScopes = (data?.scopes || []).filter(
    (s) => s.scope !== "project",
  );
  const currentScope =
    worktreeScope ||
    selectedRun?.brainScope ||
    worktreeScopes.find(
      (s) => s.root === (selectedRun?.worktree || project.path),
    )?.scope ||
    worktreeScopes[0]?.scope;
  const scopeQuery =
    scopeView === "all"
      ? "all"
      : scopeView === "current"
        ? currentScope || "project"
        : "project";
  useEffect(() => {
    selectedFile.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected, explorerOpen, fileQuery]);
  const draftKey = `fleet.note-draft.${project.id}.${selected}`;
  useEffect(() => {
    if (editing) localStorage.setItem(draftKey, draft);
  }, [draftKey, draft, editing]);
  useEffect(() => {
    let alive = true,
      timer;
    const load = () =>
      api(
        `/projects/${project.id}/brain?scope=${encodeURIComponent(scopeQuery)}`,
      )
        .then((d) => {
          if (alive) {
            setData((previous) => reconcileBrain(previous, d));
            setLoadError("");
          }
        })
        .catch((e) => {
          if (alive) setLoadError(e.message);
        })
        .finally(() => {
          if (alive) timer = setTimeout(load, 8000);
        });
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [
    project.id,
    scopeQuery,
    reload,
    state.projects.find((p) => p.id === project.id)?.brainUpdatedAt,
    state.runs
      .filter((r) => r.projectId === project.id)
      .map((r) => r.status)
      .join(","),
  ]);
  const scopedNotes = useMemo(() => {
    const overlayTopics = new Set(
      (data?.notes || [])
        .filter((n) => n.scope === currentScope)
        .map((n) => n.topic)
        .filter(Boolean),
    );
    return (data?.notes || []).filter(
      (n) =>
        scopeView === "all" ||
        ((n.scope || "project") === "project" &&
          !(scopeView === "current" && overlayTopics.has(n.topic))) ||
        (scopeView === "current" && n.scope === currentScope),
    );
  }, [data?.notes, currentScope, scopeView]);
  const files = useMemo(
    () =>
      scopedNotes
        .filter((n) =>
          `${n.title} ${n.filename}`
            .toLowerCase()
            .includes(fileQuery.toLowerCase()),
        )
        .sort((a, b) => noteCollator.compare(a.title, b.title)),
    [scopedNotes, fileQuery],
  );
  const note = scopedNotes.find((n) => n.filename === selected);
  const coverageScope = (data?.scopes || []).find(
    (s) => s.scope === (scopeView === "current" ? currentScope : "project"),
  );
  const coverage = coverageScope?.coverage;
  const links = useMemo(
    () =>
      scopedNotes.filter(
        (n) =>
          n.filename !== selected &&
          (n.links || []).some((link) =>
            [
              note?.title.toLowerCase(),
              noteTarget(note?.filename || "").toLowerCase(),
            ].includes(noteTarget(link).toLowerCase()),
          ),
      ) || [],
    [scopedNotes, selected, note?.title, note?.filename],
  );
  const choose = useCallback(
    (filename) => {
      if (editing && draft !== note?.content) {
        notify("Save or cancel your note edits before opening another note.");
        return;
      }
      setSelected(filename);
      setEditing(false);
      return true;
    },
    [editing, draft, note?.content, notify],
  );
  const followLink = useCallback(
    (title) => {
      const target = data?.notes.find((n) =>
        [n.title.toLowerCase(), noteTarget(n.filename).toLowerCase()].includes(
          noteTarget(title).toLowerCase(),
        ),
      );
      if (target) choose(target.filename);
      else notify(`No note named “${title}” yet.`);
    },
    [data?.notes, choose, notify],
  );
  const save = async () => {
    const result = await act(
      () =>
        api(`/projects/${project.id}/notes`, "POST", {
          filename: selected,
          content: draft,
        }),
      "Note saved.",
    );
    if (result) {
      localStorage.removeItem(draftKey);
      setEditing(false);
      setData(await api(`/projects/${project.id}/brain`));
    }
  };
  const add = async (e) => {
    e.preventDefault();
    const filename = noteTitle.trim() + ".md";
    if (
      data.notes.some(
        (n) => n.filename.toLowerCase() === filename.toLowerCase(),
      )
    ) {
      notify("A note with that name already exists. Choose another name.");
      return;
    }
    const result = await act(() =>
      api(`/projects/${project.id}/notes`, "POST", {
        filename,
        content: `# ${noteTitle.trim()}\n\nRelated: [[Home]]\n`,
      }),
    );
    if (result) {
      setData(await api(`/projects/${project.id}/brain`));
      if (choose(filename)) setReaderOpen(true);
      setNewNote(false);
      setNoteTitle("");
    }
  };
  if (!data)
    return (
      <div className="loading">
        <Loader2 size={18} className="spin" />
        {loadError || "Opening project brain"}
        {loadError && (
          <Button onClick={() => setReload((n) => n + 1)}>Retry</Button>
        )}
      </div>
    );
  return (
    <div
      className={`brain-workspace ${mode === "graph" ? "brain-graph-mode" : ""}`}
    >
      <header className="brain-header">
        <div>
          {mode === "graph" && (
            <button
              className="brain-explorer-toggle"
              aria-label={
                explorerOpen ? "Hide file explorer" : "Show file explorer"
              }
              title={explorerOpen ? "Hide file explorer" : "Show file explorer"}
              aria-expanded={explorerOpen}
              onClick={() => setExplorerOpen(!explorerOpen)}
            >
              {explorerOpen ? (
                <PanelLeftClose size={17} />
              ) : (
                <PanelLeftOpen size={17} />
              )}
            </button>
          )}
          <span className="brain-kicker">{project.name} / KNOWLEDGE</span>
          <h1>Project brain</h1>
        </div>
        <div className="brain-header-actions">
          <div
            className="brain-view-switch"
            role="group"
            aria-label="Brain view"
          >
            <button
              aria-pressed={mode === "graph"}
              onClick={() => setMode("graph")}
            >
              <Network size={14} />
              Graph
            </button>
            <button
              aria-pressed={mode === "notes"}
              onClick={() => setMode("notes")}
            >
              <BookOpen size={14} />
              Notes
            </button>
          </div>
          {mode === "graph" && (
            <Button icon={Eye} onClick={() => setReaderOpen(!readerOpen)}>
              {readerOpen ? "Hide note panel" : "Show note panel"}
            </Button>
          )}
          <Button icon={Plus} onClick={() => setNewNote(true)}>
            New note
          </Button>
          <Button
            icon={RefreshCw}
            onClick={async () => {
              const result = await act(
                () => api(`/projects/${project.id}/brain`, "POST"),
                "Inventory refreshed.",
              );
              if (result) setData(result);
            }}
          >
            Refresh brain
          </Button>
        </div>
      </header>
      <div className="brain-scope-bar">
        <div
          className="brain-view-switch"
          role="group"
          aria-label="Knowledge scope"
        >
          {[
            ["project", "Project"],
            ["current", "Current worktree"],
            ["all", "All worktrees"],
          ].map(([value, label]) => (
            <button
              key={value}
              aria-pressed={scopeView === value}
              onClick={() => {
                if (editing) {
                  notify(
                    "Save or cancel your note edits before switching scope.",
                  );
                  return;
                }
                setScopeView(value);
                setSelected("Home.md");
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {scopeView === "current" && (
          <select
            aria-label="Brain worktree"
            value={currentScope || ""}
            onChange={(e) => {
              if (editing) {
                notify(
                  "Save or cancel your note edits before switching scope.",
                );
                return;
              }
              setWorktreeScope(e.target.value);
              setSelected("Home.md");
            }}
          >
            {!worktreeScopes.length && (
              <option value="">Waiting for worktree index</option>
            )}
            {worktreeScopes.map((s) => (
              <option key={s.scope} value={s.scope}>
                {s.label} · {s.root.split(/[\\/]/).pop()}
              </option>
            ))}
          </select>
        )}
        <span className="muted-copy">
          {scopeView === "project"
            ? "Committed knowledge"
            : "Amber nodes are working-copy knowledge, not merged facts"}
        </span>
      </div>
      <div className="brain-auto-status">
        <span className="brain-auto-dot" />
        <span role="status">
          {data.indexing?.status === "running"
            ? "Reading code and updating links…"
            : data.indexing?.status === "queued"
              ? "Brain update queued"
              : data.indexing?.status === "failed"
                ? `Indexing needs attention: ${data.indexing.error}`
                : data.indexing?.status === "partial"
                  ? "Index updated · partial coverage"
                  : "Local index up to date"}
          {coverage &&
            ` · Wiki ${coverage.wiki.indexed}/${coverage.wiki.total} · Docs ${coverage.documents.indexed}/${coverage.documents.total} · Code ${coverage.code.indexed}/${coverage.code.total}`}
        </span>
        <details>
          <summary>What gets written?</summary>
          <div>
            Wiki and Markdown pages are imported individually with their links,
            using a separate documentation budget. Working folders and Git
            worktrees are checked every 20 seconds. Each completed turn records
            its own before/after changes. Pending worktree knowledge stays
            separate until code reaches the project's tracked branch. Your notes
            are preserved. Static relationships are observations, not verified
            runtime behaviour. No model calls or project commands are made by
            indexing or opening the graph. Wiki writing is separately budgeted
            below: it maintains sections in Fleet's copy of your wiki and
            creates missing feature, architecture, data and workflow pages. Your
            repository wiki is not overwritten. Detailed sections are reviewed
            in batches; missing evidence and oversized sections are flagged, not
            invented.
            {coverage?.omissions?.length > 0 && (
              <ul>
                {coverage.omissions.slice(0, 8).map((o) => (
                  <li key={o.path}>
                    {o.path}: {o.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </details>
        {data.writer && (
          <details className="brain-writer-settings">
            <summary>
              Writer: {data.writer.status} · {data.writer.used}/
              {data.writer.dailyCalls} calls
            </summary>
            <div>
              <strong>{data.writer.model}</strong>
              <p>
                {data.writer.queued} section batches queued ·{" "}
                {data.writer.completed} cached. Identical evidence is reused
                across worktrees.
              </p>
              <p>
                Uses your Codex account. Limits reset at midnight UTC. Call
                limits are not a guaranteed currency cap; provider billing still
                applies. Global safety limit: {data.writer.globalUsed}/
                {data.writer.globalLimit} calls today.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={data.writer.enabled}
                  onChange={async (e) => {
                    const result = await act(() =>
                      api(`/projects/${project.id}/brain`, "POST", {
                        writer: { enabled: e.target.checked },
                      }),
                    );
                    if (result) setData(result);
                  }}
                />{" "}
                Maintain project wiki
              </label>
              <label>
                Daily call limit{" "}
                <select
                  aria-label="Daily writer call limit"
                  value={data.writer.dailyCalls}
                  onChange={async (e) => {
                    const result = await act(() =>
                      api(`/projects/${project.id}/brain`, "POST", {
                        writer: { dailyCalls: Number(e.target.value) },
                      }),
                    );
                    if (result) setData(result);
                  }}
                >
                  {[...new Set([1, 5, 10, 20, 50, data.writer.dailyCalls])]
                    .sort((a, b) => a - b)
                    .map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                </select>
              </label>
              {data.writer.error && (
                <p role="alert">
                  {data.writer.error}{" "}
                  <button
                    onClick={async () => {
                      const result = await act(() =>
                        api(`/projects/${project.id}/brain`, "POST", {
                          writer: { retry: true },
                        }),
                      );
                      if (result) setData(result);
                    }}
                  >
                    Retry writer
                  </button>
                </p>
              )}
            </div>
          </details>
        )}
        <button
          onClick={() =>
            navigator.clipboard
              .writeText(data.vaultPath)
              .then(() =>
                notify("Vault path copied. Open this folder in Obsidian."),
              )
              .catch(() => notify(data.vaultPath))
          }
        >
          <Folder size={12} />
          Copy vault path
        </button>
      </div>
      {loadError && (
        <div role="alert" className="notice amber">
          Could not update notes: {loadError}. Showing the last loaded version.
        </div>
      )}
      <div
        className={`brain-layout ${mode === "graph" ? "brain-graph-layout" : ""}`}
      >
        {(mode === "notes" || explorerOpen) && (
          <aside className="notes-sidebar brain-files" aria-label="Brain files">
            <div className="notes-top">
              <span>
                <Folder size={15} />
                Files
              </span>
              <button
                className="icon-button"
                aria-label="New brain note"
                onClick={() => setNewNote(true)}
              >
                <Plus size={16} />
              </button>
            </div>
            <div className="notes-search">
              <Search size={14} />
              <input
                placeholder="Find a note…"
                aria-label="Find a note"
                value={fileQuery}
                onChange={(e) => setFileQuery(e.target.value)}
              />
            </div>
            <div className="note-list">
              {files.map((n) => (
                <button
                  key={n.filename}
                  ref={n.filename === selected ? selectedFile : null}
                  aria-label={`Open file: ${n.title}`}
                  aria-current={n.filename === selected ? "page" : undefined}
                  title={n.sourcePath || n.filename}
                  className={n.filename === selected ? "selected" : ""}
                  onClick={() => {
                    if (choose(n.filename)) {
                      setReaderOpen(true);
                      if (
                        mode === "graph" &&
                        window.matchMedia?.("(max-width: 900px)").matches
                      )
                        setExplorerOpen(false);
                    }
                  }}
                >
                  <FileText size={15} />
                  <span>{n.title}</span>
                  {n.stale ? (
                    <span
                      title="Source revision has changed"
                      className="note-dot stale"
                    />
                  ) : n.generated ? (
                    <span
                      title={
                        n.maintenance
                          ? `Wiki: ${n.maintenance.status}`
                          : "Generated inventory"
                      }
                      className="note-dot"
                    />
                  ) : null}
                </button>
              ))}
              {!files.length && (
                <p className="brain-files-empty">
                  {scopedNotes.length ? "No matching notes." : "No notes yet."}
                </p>
              )}
            </div>
            <div className="vault-meta">
              <span title={data.vaultPath}>
                <Folder size={13} />
                {project.name}
              </span>
              <span>{scopedNotes.length} notes</span>
            </div>
          </aside>
        )}
        {mode === "graph" && (
          <BrainGraph
            notes={scopedNotes}
            selected={selected}
            onSelect={(filename) => {
              if (choose(filename)) setReaderOpen(true);
            }}
            query={query}
            onQuery={setQuery}
          />
        )}
        <article
          className="note-content"
          hidden={mode === "graph" && !readerOpen}
        >
          {note ? (
            <>
              <div className="note-toolbar">
                <span>
                  <FileText size={13} />
                  {note.filename}
                </span>
                <div>
                  {!editing && (
                    <details className="note-context-menu">
                      <summary>Context</summary>
                      <label>
                        <input
                          type="checkbox"
                          checked={
                            !!project.contextPreferences?.pinned?.includes(
                              note.filename,
                            )
                          }
                          onChange={(e) =>
                            act(() =>
                              api(`/projects/${project.id}`, "PATCH", {
                                contextPreferences: {
                                  pinned: e.target.checked
                                    ? [
                                        ...(project.contextPreferences
                                          ?.pinned || []),
                                        note.filename,
                                      ]
                                    : (
                                        project.contextPreferences?.pinned || []
                                      ).filter((n) => n !== note.filename),
                                  excluded:
                                    project.contextPreferences?.excluded || [],
                                },
                              }),
                            )
                          }
                        />{" "}
                        Pin for future sessions
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={
                            !!project.contextPreferences?.excluded?.includes(
                              note.filename,
                            )
                          }
                          onChange={(e) =>
                            act(() =>
                              api(`/projects/${project.id}`, "PATCH", {
                                contextPreferences: {
                                  excluded: e.target.checked
                                    ? [
                                        ...(project.contextPreferences
                                          ?.excluded || []),
                                        note.filename,
                                      ]
                                    : (
                                        project.contextPreferences?.excluded ||
                                        []
                                      ).filter((n) => n !== note.filename),
                                  pinned:
                                    project.contextPreferences?.pinned || [],
                                },
                              }),
                            )
                          }
                        />{" "}
                        Exclude from context
                      </label>
                    </details>
                  )}
                  {note.proposal && (
                    <Button
                      disabled={note.stale}
                      onClick={async () => {
                        const result = await act(() =>
                          api(`/projects/${project.id}/approve-note`, "POST", {
                            filename: note.filename,
                          }),
                        );
                        if (result)
                          setData(await api(`/projects/${project.id}/brain`));
                      }}
                    >
                      Approve proposal
                    </Button>
                  )}
                  {note.generated ? (
                    <span className="generated-label">
                      <RefreshCw size={12} />
                      {note.maintenance
                        ? `${note.maintenance.status.replaceAll("-", " ")} · ${note.maintenance.revisions || 0} revisions`
                        : "Auto-maintained"}
                    </span>
                  ) : editing ? (
                    <>
                      <Button
                        onClick={() => {
                          localStorage.removeItem(draftKey);
                          setEditing(false);
                        }}
                      >
                        Cancel
                      </Button>
                      <Button primary icon={Check} onClick={save}>
                        Save note
                      </Button>
                    </>
                  ) : (
                    <Button
                      icon={Pencil}
                      onClick={() => {
                        setDraft(
                          localStorage.getItem(draftKey) ?? note.content,
                        );
                        setEditing(true);
                      }}
                    >
                      Edit note
                    </Button>
                  )}
                </div>
              </div>
              {note.stale && (
                <div className="notice amber">
                  <Clock3 size={15} />
                  Source revision changed. Refresh the inventory before relying
                  on generated facts.
                </div>
              )}
              {note.pending && (
                <div className="notice amber">
                  Working-copy knowledge · not a merged project fact. Source:{" "}
                  {data.scopes?.find((s) => s.scope === note.scope)?.label ||
                    "archived worktree"}
                  .
                </div>
              )}
              {editing ? (
                <textarea
                  className="note-editor"
                  aria-label="Markdown note"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
              ) : (
                <div className="note-prose">
                  {(mode !== "graph" || readerOpen) && (
                    <NoteMarkdown onLink={followLink}>
                      {note.content}
                    </NoteMarkdown>
                  )}
                  <div className="backlinks">
                    <div className="eyebrow">
                      <Link2 size={13} />
                      LINKED FROM
                    </div>
                    {links.length ? (
                      links.map((n) => (
                        <button
                          key={n.filename}
                          onClick={() => choose(n.filename)}
                        >
                          <FileText size={13} />
                          {n.title}
                          <ArrowUpRight size={12} />
                        </button>
                      ))
                    ) : (
                      <p>No incoming links yet.</p>
                    )}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="note-prose">
              <h2>Choose a note</h2>
              <p>Select a node to read its note and explore its connections.</p>
            </div>
          )}
        </article>
      </div>
      {newNote && (
        <Dialog
          title="A new note"
          subtitle="Give a decision or piece of knowledge a home."
          onClose={() => setNewNote(false)}
        >
          <form onSubmit={add}>
            <Field label="Note title">
              <input
                autoFocus
                required
                value={noteTitle}
                onChange={(e) => setNoteTitle(e.target.value)}
                placeholder="Why we chose PostgreSQL"
                pattern="[a-zA-Z0-9 _.-]+"
              />
            </Field>
            <div className="dialog-actions">
              <Button onClick={() => setNewNote(false)} type="button">
                Cancel
              </Button>
              <Button primary type="submit">
                Create note
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}

export { BrainView };
