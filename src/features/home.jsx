import React, { useState } from "react";
import {
  ArrowRight,
  FolderOpen,
  GitBranch,
  MessageSquare,
  Plus,
  Search,
  X,
} from "lucide-react";

const stamp = (value) =>
  Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const recent = (a, b) =>
  stamp(b.updatedAt || b.createdAt) - stamp(a.updatedAt || a.createdAt);
const folderPath = (p) => p.sourcePath || p.path || "";
const projectTone = (id) =>
  [...id].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 3;
const folderName = (p) => folderPath(p).split(/[\\/]/).filter(Boolean).at(-1);
const dateLabel = (value) =>
  stamp(value)
    ? new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "short",
      }).format(new Date(value))
    : null;

export function HomePage({
  state,
  selected,
  showExamples,
  onProject,
  onContinue,
  onNew,
  onOpen,
  onScratch,
  busy,
}) {
  const [query, setQuery] = useState("");
  const visible = state.projects.filter((p) => showExamples || !p.example);
  const allowed = new Set(visible.map((p) => p.id));
  const conversations = state.runs
    .filter(
      (r) =>
        allowed.has(r.projectId) &&
        !r.reviewOf &&
        !r.teamInitial &&
        (!r.teamRole || r.teamRole === "developer"),
    )
    .sort(recent);
  // Keep drafts and team placeholders in their workspace, not in recent work.
  const meaningful = conversations.filter(
    (r) =>
      !r.waitingForTask &&
      !(
        r.teamRole === "developer" && /^developer$/i.test(r.title?.trim() || "")
      ),
  );
  const resume = meaningful.find((r) => r.id === selected) || meaningful[0];
  const recents = [resume, ...meaningful.filter((r) => r.id !== resume?.id)]
    .filter(Boolean)
    .slice(0, 3);
  const named = visible.filter((p) => p.kind !== "scratch");
  const names = new Map();
  named.forEach((p) => names.set(p.name, (names.get(p.name) || 0) + 1));
  const displayName = (p) =>
    names.get(p.name) > 1 && folderName(p) ? folderName(p) : p.name;
  const projects = named
    .map((p) => {
      const latest = meaningful.find((r) => r.projectId === p.id);
      return {
        ...p,
        activity: latest?.updatedAt || latest?.createdAt || p.createdAt,
      };
    })
    .sort((a, b) => stamp(b.activity) - stamp(a.activity));
  const matching = projects.filter((p) =>
    `${p.name} ${folderPath(p)}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const scratch = conversations.filter(
    (r) => visible.find((p) => p.id === r.projectId)?.kind === "scratch",
  );

  return (
    <main className="home-page" aria-label="Home">
      <div className="home-inner">
        <header className="home-heading">
          <span className="home-eyebrow">HOME</span>
          <h1>Your workspace</h1>
          <p>A place to pick up where you left off.</p>
        </header>
        <div className="home-layout">
          <aside className="home-start" aria-label="Start working">
            <h2>Start something</h2>
            <button
              className="home-start-action home-start-primary"
              aria-label="New project"
              onClick={onNew}
              disabled={busy}
            >
              <Plus size={18} />
              <span>
                <strong>New project</strong>
                <small>Build from a fresh folder</small>
              </span>
            </button>
            <button
              className="home-start-action"
              aria-label="Open folder"
              onClick={onOpen}
              disabled={busy}
            >
              <FolderOpen size={18} />
              <span>
                <strong>Open folder</strong>
                <small>Bring your existing code</small>
              </span>
            </button>
            <div className="home-scratch-start">
              <button
                className="home-start-action"
                aria-label="Start without a project"
                onClick={onScratch}
                disabled={busy}
              >
                <MessageSquare size={17} />
                <span>
                  <strong>Just a conversation</strong>
                  <small>No project needed</small>
                </span>
              </button>
              {scratch.length > 0 && (
                <details className="home-scratch">
                  <summary>Scratch conversations ({scratch.length})</summary>
                  {scratch.map((r) => (
                    <button
                      key={r.id}
                      aria-label={r.title}
                      onClick={() => onContinue(r.id)}
                    >
                      {r.title}
                      <ArrowRight size={13} />
                    </button>
                  ))}
                </details>
              )}
            </div>
          </aside>
          <div className="home-library">
            <section aria-label="Your projects">
              <div className="home-project-heading">
                <h2>
                  Projects <span>{projects.length}</span>
                </h2>
                {projects.length > 0 && (
                  <div className="home-search">
                    <Search size={14} />
                    <input
                      aria-label="Find a project"
                      placeholder="Find a project…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    {query && (
                      <button
                        aria-label="Clear project search"
                        onClick={() => setQuery("")}
                      >
                        <X size={13} />
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className="home-project-grid">
                {matching.map((p) => (
                  <button
                    className="home-project"
                    data-tone={projectTone(p.id)}
                    key={p.id}
                    onClick={() => onProject(p.id)}
                    aria-label={`Open ${p.name} — ${folderPath(p) || "project"}`}
                  >
                    <span className="home-project-top">
                      <span className="home-project-initial" aria-hidden="true">
                        {(displayName(p) || "?").slice(0, 2).toUpperCase()}
                      </span>
                      <ArrowRight className="home-project-arrow" size={16} />
                    </span>
                    <span className="home-project-name">
                      <strong>{displayName(p)}</strong>
                      <small title={folderPath(p)}>
                        {folderPath(p) || "Folder path unavailable"}
                      </small>
                    </span>
                    <span className="home-project-bottom">
                      {p.branch ? (
                        <span title={`Branch: ${p.branch}`}>
                          <GitBranch size={12} />
                          {p.branch}
                        </span>
                      ) : (
                        <span>
                          <FolderOpen size={12} />
                          Folder
                        </span>
                      )}
                      <span>Open workspace</span>
                    </span>
                  </button>
                ))}
              </div>
              {!projects.length && (
                <div className="home-empty">
                  <FolderOpen size={28} strokeWidth={1.3} />
                  <h3>Your next project starts here</h3>
                  <p>
                    Open a folder you’re already working in,
                    <br />
                    or create something new.
                  </p>
                  <button onClick={onOpen} disabled={busy}>
                    Choose a folder <ArrowRight size={14} />
                  </button>
                </div>
              )}
              {projects.length > 0 && !matching.length && (
                <div className="home-empty">
                  <h3>No matching projects</h3>
                  <p>No projects match “{query}”.</p>
                  <button onClick={() => setQuery("")}>
                    Clear search <X size={14} />
                  </button>
                </div>
              )}
            </section>
            {recents.length > 0 && (
              <section
                className="home-recents"
                aria-label="Recent conversations"
              >
                <h2>Pick up a conversation</h2>
                <div>
                  {recents.map((r) => {
                    const project = visible.find((p) => p.id === r.projectId);
                    return (
                      <button
                        className="home-recent"
                        key={r.id}
                        aria-label={`Continue working: ${r.title}`}
                        onClick={() => onContinue(r.id)}
                      >
                        <MessageSquare size={16} />
                        <span className="home-recent-name">
                          <strong>{r.title}</strong>
                          <small>
                            {project.kind === "scratch"
                              ? "Scratch"
                              : displayName(project)}
                          </small>
                        </span>
                        {dateLabel(r.updatedAt || r.createdAt) && (
                          <time
                            dateTime={new Date(
                              r.updatedAt || r.createdAt,
                            ).toISOString()}
                          >
                            {dateLabel(r.updatedAt || r.createdAt)}
                          </time>
                        )}
                        <ArrowRight size={14} />
                      </button>
                    );
                  })}
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
