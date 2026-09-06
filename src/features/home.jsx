import React, { useState } from "react";
import {
  ArrowRight,
  FolderOpen,
  GitBranch,
  MessageSquare,
  Plus,
  Search,
  X,
  CircleDot,
  ShieldAlert,
  AlertCircle,
  Clock3,
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
const excerpt = (run) => {
  const text = (run.summary || run.initialPrompt || run.prompt || "")
    .replace(/[#*`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 190 ? text.slice(0, 187).trimEnd() + "…" : text;
};
const statusLabels = {
  draft: "Not started",
  queued: "Queued",
  preparing: "Preparing",
  running: "Working",
  pausing: "Stopping",
  paused: "Paused",
  interrupted: "Interrupted",
  review: "Ready to review",
  validating: "Checking",
  accepting: "Accepting",
  accepted: "Accepted",
  failed: "Failed",
  cancelled: "Cancelled",
};

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
  const projectById = new Map(visible.map((p) => [p.id, p]));
  const runs = state.runs.filter(
    (r) => projectById.has(r.projectId) && !r.deletedAt,
  );
  const conversations = runs
    .filter(
      (r) =>
        r.sessionKind !== "terminal" &&
        !r.reviewOf &&
        !r.teamInitial &&
        (!r.teamRole || r.teamRole === "developer"),
    )
    .sort(recent);
  const meaningful = conversations.filter(
    (r) =>
      !r.waitingForTask &&
      !(
        r.teamRole === "developer" && /^developer$/i.test(r.title?.trim() || "")
      ),
  );
  const resume = meaningful.find((r) => r.id === selected) || meaningful[0];
  const recents = meaningful.filter((r) => r.id !== resume?.id).slice(0, 4);
  const named = visible.filter((p) => p.kind !== "scratch");
  const names = new Map();
  named.forEach((p) => names.set(p.name, (names.get(p.name) || 0) + 1));
  const displayName = (p) =>
    p.kind === "scratch"
      ? "Scratch"
      : names.get(p.name) > 1 && folderName(p)
        ? folderName(p)
        : p.name;
  const projects = named
    .map((p) => {
      const latest = meaningful.find((r) => r.projectId === p.id);
      return {
        ...p,
        activity: latest?.updatedAt || latest?.createdAt || p.createdAt,
        chatCount: conversations.filter((r) => r.projectId === p.id).length,
        latest,
      };
    })
    .sort((a, b) => stamp(b.activity) - stamp(a.activity));
  const matching = projects.filter((p) =>
    `${p.name} ${folderPath(p)}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const scratch = conversations.filter(
    (r) => projectById.get(r.projectId)?.kind === "scratch",
  );
  const findingCounts = new Map();
  for (const finding of state.findings || []) {
    if (
      finding.state === "suspected" &&
      runs.some((r) => r.id === finding.runId)
    )
      findingCounts.set(
        finding.runId,
        (findingCounts.get(finding.runId) || 0) + 1,
      );
  }
  const attention = runs
    .map((run) => {
      const count = findingCounts.get(run.id);
      if (count)
        return {
          run,
          priority: 0,
          Icon: ShieldAlert,
          label: `${count} security finding${count === 1 ? "" : "s"}`,
        };
      if (["failed", "interrupted"].includes(run.status))
        return {
          run,
          priority: 1,
          Icon: AlertCircle,
          label: run.status === "failed" ? "Run failed" : "Run interrupted",
        };
      if (run.blockedReason)
        return {
          run,
          priority: 1,
          Icon: AlertCircle,
          label: "Needs a decision",
        };
      if (run.status === "review" && meaningful.some((r) => r.id === run.id))
        return { run, priority: 2, Icon: CircleDot, label: "Ready to review" };
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => a.priority - b.priority || recent(a.run, b.run));
  const resumeProject = resume && projectById.get(resume.projectId);
  const Time = ({ value }) =>
    dateLabel(value) ? (
      <time dateTime={new Date(value).toISOString()}>{dateLabel(value)}</time>
    ) : null;

  return (
    <main className="home-page" aria-label="Home">
      <div className="home-inner">
        <header className="home-heading">
          <div>
            <span className="home-eyebrow">HOME</span>
            <h1>Your workspace</h1>
            <p>Pick up a thread. Start something new.</p>
          </div>
          <div className="home-start" role="group" aria-label="Start working">
            <button
              className="home-start-action home-start-primary"
              aria-label="New project"
              onClick={onNew}
              disabled={busy}
            >
              <Plus size={15} />
              <span>New project</span>
            </button>
            <button
              className="home-start-action"
              aria-label="Open folder"
              onClick={onOpen}
              disabled={busy}
            >
              <FolderOpen size={15} />
              <span>Open folder</span>
            </button>
            <button
              className="home-start-action"
              aria-label="Start without a project"
              onClick={onScratch}
              disabled={busy}
            >
              <MessageSquare size={15} />
              <span>Quick chat</span>
            </button>
          </div>
        </header>
        {resume && (
          <section className="home-resume" aria-label="Continue working">
            <button
              aria-label={`Continue working: ${resume.title}`}
              onClick={() => onContinue(resume.id)}
            >
              <div className="home-resume-top">
                <span className="home-eyebrow">CONTINUE WORKING</span>
                {statusLabels[resume.status] && (
                  <span className="home-run-status" data-status={resume.status}>
                    <CircleDot size={12} />
                    {statusLabels[resume.status]}
                  </span>
                )}
              </div>
              <h2>{resume.title}</h2>
              {excerpt(resume) && (
                <p className="home-resume-excerpt">{excerpt(resume)}</p>
              )}
              <div className="home-resume-bottom">
                <span>
                  <FolderOpen size={13} />
                  {displayName(resumeProject)}
                </span>
                {resume.branch && (
                  <span className="home-resume-branch">
                    <GitBranch size={12} />
                    {resume.branch}
                  </span>
                )}
                <Time value={resume.updatedAt || resume.createdAt} />
                <strong>
                  Open conversation <ArrowRight size={15} />
                </strong>
              </div>
            </button>
          </section>
        )}
        <div
          className={`home-layout ${attention.length ? "has-attention" : ""}`}
        >
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
              <div className="home-project-list">
                {matching.map((p) => (
                  <button
                    className="home-project"
                    data-tone={projectTone(p.id)}
                    key={p.id}
                    onClick={() => onProject(p.id)}
                    aria-label={`Open ${p.name} — ${folderPath(p) || "project"}`}
                  >
                    <span className="home-project-initial" aria-hidden="true">
                      {(displayName(p) || "?").slice(0, 2).toUpperCase()}
                    </span>
                    <span className="home-project-name">
                      <strong>{displayName(p)}</strong>
                      <small title={folderPath(p)}>
                        {folderPath(p) || "Folder path unavailable"}
                      </small>
                      {p.latest && (
                        <span className="home-project-latest">
                          <MessageSquare size={11} />
                          {p.latest.title}
                        </span>
                      )}
                    </span>
                    <span className="home-project-meta">
                      <span>
                        {p.chatCount} {p.chatCount === 1 ? "chat" : "chats"}
                      </span>
                      {p.branch && (
                        <span
                          className="home-project-branch"
                          title={`Branch: ${p.branch}`}
                        >
                          <GitBranch size={11} />
                          {p.branch}
                        </span>
                      )}
                      <Time value={p.activity} />
                    </span>
                    <ArrowRight className="home-project-arrow" size={15} />
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
                <div className="home-section-heading">
                  <h2>Recent conversations</h2>
                  <span>Latest threads</span>
                </div>
                {recents.map((r) => (
                  <button
                    className="home-recent"
                    key={r.id}
                    aria-label={`Continue working: ${r.title}`}
                    onClick={() => onContinue(r.id)}
                  >
                    <MessageSquare size={15} />
                    <span className="home-recent-name">
                      <strong>{r.title}</strong>
                      <small>
                        {displayName(projectById.get(r.projectId))}
                        {statusLabels[r.status]
                          ? ` · ${statusLabels[r.status]}`
                          : ""}
                      </small>
                    </span>
                    <Time value={r.updatedAt || r.createdAt} />
                    <ArrowRight size={14} />
                  </button>
                ))}
              </section>
            )}
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
          {attention.length > 0 && (
            <aside className="home-attention" aria-label="Needs your attention">
              <div className="home-section-heading">
                <h2>Needs your attention</h2>
                <span className="home-attention-count">{attention.length}</span>
              </div>
              <p className="home-attention-intro">
                Work waiting for your next move.
              </p>
              <div className="home-attention-items">
                {attention.slice(0, 4).map(({ run, Icon, label, priority }) => (
                  <button
                    key={run.id}
                    aria-label={`${label}: ${run.title}`}
                    onClick={() => onContinue(run.id)}
                  >
                    <span
                      className="home-attention-label"
                      data-priority={priority}
                    >
                      <Icon size={13} />
                      {label}
                    </span>
                    <strong>{run.title}</strong>
                    <span className="home-attention-project">
                      {displayName(projectById.get(run.projectId))}
                      <ArrowRight size={13} />
                    </span>
                  </button>
                ))}
              </div>
              {attention.length > 4 && (
                <details className="home-attention-more">
                  <summary>{attention.length - 4} more items</summary>
                  {attention.slice(4).map(({ run, label }) => (
                    <button key={run.id} onClick={() => onContinue(run.id)}>
                      {label}: {run.title}
                    </button>
                  ))}
                </details>
              )}
              <div className="home-attention-note">
                <Clock3 size={13} />
                <span>Opening a chat won’t start an agent.</span>
              </div>
            </aside>
          )}
        </div>
      </div>
    </main>
  );
}
