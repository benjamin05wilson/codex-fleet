import React, { useEffect, useRef, useState } from "react";
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
function BrainView({ project, act, state, notify, requestedNote }) {
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
  useEffect(() => {
    selectedFile.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected, explorerOpen, fileQuery]);
  const draftKey = `fleet.note-draft.${project.id}.${selected}`;
  useEffect(() => {
    if (editing) localStorage.setItem(draftKey, draft);
  }, [draftKey, draft, editing]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api(`/projects/${project.id}/brain`)
        .then((d) => {
          if (alive) {
            setData((previous) =>
              JSON.stringify(previous) === JSON.stringify(d) ? previous : d,
            );
            setLoadError("");
          }
        })
        .catch((e) => {
          if (alive) setLoadError(e.message);
        });
    load();
    const timer = setInterval(load, 8000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [
    project.id,
    reload,
    state.projects.find((p) => p.id === project.id)?.brainUpdatedAt,
    state.runs
      .filter((r) => r.projectId === project.id)
      .map((r) => r.status)
      .join(","),
  ]);
  const note = data?.notes.find((n) => n.filename === selected);
  const links =
    data?.notes.filter(
      (n) =>
        n.filename !== selected &&
        (n.links || []).some(
          (link) =>
            noteTarget(link).toLowerCase() === note?.title.toLowerCase(),
        ),
    ) || [];
  const choose = (filename) => {
    if (editing && draft !== note?.content) {
      notify("Save or cancel your note edits before opening another note.");
      return;
    }
    setSelected(filename);
    setEditing(false);
    return true;
  };
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
            Refresh inventory
          </Button>
        </div>
      </header>
      <div className="brain-auto-status">
        <span className="brain-auto-dot" />
        Automatic writing
        <details>
          <summary>What gets written?</summary>
          <div>
            Committed repository changes are checked every 20 seconds. Finished
            sessions write receipts with their objective, changed files and
            outcome. Your notes are preserved. AI memory proposals need approval
            before becoming trusted context. This view checks for new notes
            every 8 seconds; no model calls are made by opening the graph.
          </div>
        </details>
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
              {data.notes
                .filter((n) =>
                  `${n.title} ${n.filename}`
                    .toLowerCase()
                    .includes(fileQuery.toLowerCase()),
                )
                .sort((a, b) =>
                  a.title.localeCompare(b.title, undefined, {
                    numeric: true,
                    sensitivity: "base",
                  }),
                )
                .map((n) => (
                  <button
                    key={n.filename}
                    ref={n.filename === selected ? selectedFile : null}
                    aria-label={`Open file: ${n.title}`}
                    aria-current={n.filename === selected ? "page" : undefined}
                    title={n.filename}
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
                      <span title="Generated inventory" className="note-dot" />
                    ) : null}
                  </button>
                ))}
              {!data.notes.some((n) =>
                `${n.title} ${n.filename}`
                  .toLowerCase()
                  .includes(fileQuery.toLowerCase()),
              ) && (
                <p className="brain-files-empty">
                  {data.notes.length ? "No matching notes." : "No notes yet."}
                </p>
              )}
            </div>
            <div className="vault-meta">
              <span title={data.vaultPath}>
                <Folder size={13} />
                {project.name}
              </span>
              <span>{data.notes.length} notes</span>
            </div>
          </aside>
        )}
        {mode === "graph" && (
          <BrainGraph
            notes={data.notes}
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
                      Auto-maintained
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
              {editing ? (
                <textarea
                  className="note-editor"
                  aria-label="Markdown note"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
              ) : (
                <div className="note-prose">
                  <MD
                    onLink={(title) => {
                      const target = data.notes.find(
                        (n) =>
                          n.title.toLowerCase() ===
                          noteTarget(title).toLowerCase(),
                      );
                      if (target) choose(target.filename);
                      else notify(`No note named “${title}” yet.`);
                    }}
                  >
                    {note.content}
                  </MD>
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
