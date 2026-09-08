import React, { useEffect, useRef, useState } from "react";
import { TeamReviews, TeamBadge } from "./team.jsx";
import { SessionFiles, SessionOptions } from "./workspace.jsx";
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
function SessionLanding({ runs, onSelect, onCreate, project }) {
  const review = runs.filter((r) => r.status === "review");
  return (
    <div className="session-landing">
      <div className="landing-heading">
        <span className="eyebrow">{project.name}</span>
        <h2>No session selected</h2>
        <p>
          Pick up a session on the left, or give Codex something new to work on.
        </p>
      </div>
      <div className="landing-rule" />
      <div className="landing-section-title">
        <span>{review.length ? "AWAITING REVIEW" : "READY TO START"}</span>
        <ArrowUpRight size={14} />
      </div>
      {(review.length ? review : runs.filter((r) => r.status === "draft"))
        .slice(0, 3)
        .map((r, i) => (
          <button
            className="suggestion"
            key={r.id}
            onClick={() => onSelect(r.id)}
          >
            <span className="suggestion-number">0{i + 1}</span>
            <div>
              <strong>{r.title}</strong>
              <span>
                {r.sandbox === "read-only"
                  ? "Explore without changing files"
                  : "Make a change in an isolated worktree"}
              </span>
            </div>
            <ArrowRight size={17} />
          </button>
        ))}
      {!runs.some((r) => r.status === "draft" || r.status === "review") && (
        <button className="suggestion" onClick={onCreate}>
          <Plus size={20} />
          <div>
            <strong>Start a new thread</strong>
            <span>A focused task, a clear outcome.</span>
          </div>
          <ArrowRight size={17} />
        </button>
      )}
      <div className="workbench-note">
        <BookOpen size={18} />
        <p>
          Context carries forward.
          <br />
          <span>Finished sessions leave a receipt in your project brain.</span>
        </p>
      </div>
      <div className="landing-meta">
        <span>
          <GitBranch size={13} />
          {project.branch}
        </span>
        <span>Isolated sessions</span>
        <span>Local storage</span>
      </div>
    </div>
  );
}

import { Sentinel } from "./security.jsx";
import { TerminalView } from "./terminal.jsx";
import { Preview } from "./preview.jsx";
import { ProjectBrowser } from "./browser.jsx";

function RunDetail({
  runId,
  project,
  state,
  act,
  busy,
  goRun,
  onSettings,
  browserRequest,
}) {
  const [detail, setDetail] = useState(null);
  const [tab, setTab] = useState(() => {
    const selected = state.runs.find((r) => r.id === runId);
    const saved = localStorage.getItem(`fleet.tool.${runId}`);
    if (
      [
        "conversation",
        "review",
        ...(!selected?.teamRole || selected.teamRole === "developer"
          ? ["files", "preview", "browser"]
          : []),
      ].includes(saved)
    )
      return saved;
    return selected?.teamRole && selected.teamRole !== "developer"
      ? "review"
      : "conversation";
  });
  const [diff, setDiff] = useState(null);
  useEffect(() => {
    if (
      browserRequest?.runId === runId &&
      browserRequest.projectId === project.id
    )
      setTab("browser");
  }, [browserRequest, runId, project.id]);
  const [optionsOpen, setOptionsOpen] = useState(false);
  useEffect(() => {
    // Reopening a shell requires a deliberate click, even though its process may survive.
    localStorage.setItem(
      `fleet.tool.${runId}`,
      tab === "terminal" ? "conversation" : tab,
    );
  }, [tab, runId]);
  const [followup, setFollowup] = useState(
    () => localStorage.getItem(`fleet.draft.${runId}`) || "",
  );
  const [context, setContext] = useState(null);
  const [historyComplete, setHistoryComplete] = useState(false);
  useEffect(() => {
    localStorage.setItem(`fleet.draft.${runId}`, followup);
  }, [followup, runId]);
  const [expanded, setExpanded] = useState({});
  const run = state.runs.find((r) => r.id === runId);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api(`/runs/${runId}`)
        .then((d) => {
          if (alive)
            setDetail((previous) => ({
              ...d,
              events: [
                ...new Map(
                  [...(previous?.events || []), ...(d.events || [])].map(
                    (e) => [e.seq, e],
                  ),
                ).values(),
              ].sort((a, b) => a.seq - b.seq),
            }));
        })
        .catch(() => {});
    load();
    const stream =
      typeof EventSource === "undefined"
        ? null
        : new EventSource("/api/stream");
    let scheduled;
    stream?.addEventListener("change", () => {
      if (!scheduled)
        scheduled = setTimeout(() => {
          scheduled = null;
          load();
        }, 150);
    });
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
      clearTimeout(scheduled);
      stream?.close();
    };
  }, [runId]);
  useEffect(() => {
    if (tab !== "review") return;
    let alive = true;
    api(`/runs/${runId}/diff`)
      .then((d) => {
        if (alive) setDiff(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tab, runId, run?.updatedAt]);
  if (!run || !detail)
    return (
      <div className="loading">
        <Loader2 className="spin" size={18} />
        Loading session
      </div>
    );
  const events = detail.events || [];
  const messages = events.filter(
    (e) =>
      (e.type === "item.completed" && e.data.item?.type === "agent_message") ||
      (e.type === "run.queued" && e.data.prompt && !e.data.initialInstruction),
  );
  const lastMessageSeq = Math.max(
    0,
    ...events
      .filter(
        (e) =>
          e.type === "item.completed" && e.data.item?.type === "agent_message",
      )
      .map((e) => e.seq),
  );
  const streaming = events
    .filter((e) => e.type === "message.delta" && e.seq > lastMessageSeq)
    .map((e) => e.data.delta)
    .join("");
  const commands = events.filter(
    (e) =>
      e.type === "item.completed" && e.data.item?.type === "command_execution",
  );
  const findings = state.findings.filter(
    (f) => f.runId === runId && f.state === "suspected",
  );
  const isActive = activeStatuses.includes(run.status);
  const teamReviewer = run.teamRole && run.teamRole !== "developer";
  const start = () =>
    act(() =>
      api(`/runs/${runId}/start`, "POST", { prompt: followup || undefined }),
    ).then((r) => {
      if (r) setFollowup("");
    });
  const canConfigure =
    !teamReviewer &&
    !run.teamInitial &&
    !run.workflowId &&
    !run.reviewOf &&
    ["draft", "paused", "interrupted", "failed", "review"].includes(
      run.status,
    ) &&
    !run.shellOpen &&
    !["starting", "running", "stopping"].includes(run.preview?.status);
  const showTool = async (tool) => {
    setTab(tool);
    if (tool === "details") {
      const c = await act(() =>
        api(`/projects/${project.id}/context?runId=${runId}`),
      );
      if (c) setContext(c);
    }
  };
  return (
    <div className="run-detail">
      {optionsOpen && (
        <SessionOptions
          run={run}
          act={act}
          onClose={() => setOptionsOpen(false)}
        />
      )}
      <div className="run-head">
        <h2>{run.title}</h2>
        {run.sessionKind && (
          <span className="workspace-kind" title={run.worktree}>
            {run.workspaceKind === "main" ? "Main folder" : run.branch}
          </span>
        )}
        {!["draft", "review", "accepted"].includes(run.status) && (
          <Status status={run.status} />
        )}
        <TeamBadge
          quiet
          projectId={project.id}
          runId={runId}
          state={state}
          goRun={goRun}
          onSettings={onSettings}
        />
        {run.files.length > 0 && (
          <button className="context-action" onClick={() => setTab("review")}>
            {run.files.length} {run.files.length === 1 ? "file" : "files"}{" "}
            changed
          </button>
        )}
        {findings.length > 0 && (
          <button
            className="context-action attention"
            onClick={() => setTab("review")}
          >
            {findings.length} security{" "}
            {findings.length === 1 ? "observation" : "observations"}
          </button>
        )}
        <details className="tools-menu">
          <summary>
            Tools <ChevronDown size={13} />
          </summary>
          <div
            className="workspace-menu"
            onClick={(e) => {
              if (e.target.closest("button"))
                e.currentTarget.closest("details").open = false;
            }}
          >
            {!teamReviewer && (
              <>
                <button onClick={() => showTool("files")}>Files</button>
                <button onClick={() => showTool("preview")}>Preview</button>
                <button onClick={() => showTool("browser")}>Browser</button>
                <button onClick={() => showTool("terminal")}>
                  Worktree shell
                </button>
              </>
            )}
            <button onClick={() => showTool("review")}>Changes & checks</button>
            <button onClick={() => showTool("details")}>Session details</button>
          </div>
        </details>
        <div className="run-controls">
          {!teamReviewer &&
            !run.waitingForTask &&
            !run.teamInitial &&
            ["draft", "paused", "interrupted", "failed"].includes(
              run.status,
            ) && (
              <Button primary icon={Play} disabled={busy} onClick={start}>
                {run.status === "draft"
                  ? "Start session"
                  : run.threadId
                    ? "Resume session"
                    : "Retry session"}
              </Button>
            )}
          {run.status === "queued" && (
            <Button
              icon={Square}
              onClick={() =>
                act(() => api(`/runs/${runId}/cancel`, "POST", {}))
              }
            >
              Remove from queue
            </Button>
          )}
          {["running", "preparing", "pausing"].includes(run.status) && (
            <Button
              icon={Pause}
              disabled={run.status === "pausing"}
              onClick={() => act(() => api(`/runs/${runId}/pause`, "POST", {}))}
            >
              Pause
            </Button>
          )}
          {run.reviewOf && (
            <Button icon={ArrowLeft} onClick={() => goRun(run.reviewOf)}>
              Implementation
            </Button>
          )}
          {run.status === "accepted" && (
            <span className="accepted-note">
              <CheckCheck size={15} />
              Saved to {run.branch} · {run.acceptedSha?.slice(0, 7)}
            </span>
          )}
        </div>
      </div>
      <div
        className={`session-panes ${tab !== "conversation" ? "with-tool" : ""}`}
      >
        <section className="conversation-pane" aria-label="Codex conversation">
          {run.sandbox === "danger-full-access" && (
            <div className="main-folder-context yolo-context">
              YOLO · no sandbox or approval prompts · commands can affect files
              outside this project
            </div>
          )}
          {run.workspaceKind === "main" && (
            <div className="main-folder-context">
              <span>
                Main working folder ·{" "}
                {run.sandbox === "read-only"
                  ? "read-only"
                  : "edits affect your original files"}
              </span>
              <code title={run.worktree}>{run.worktree}</code>
            </div>
          )}
          <div className="detail-scroll">
            {run.error && (
              <div className="notice error">
                <AlertTriangle size={16} />
                <div>
                  <strong>Session needs attention</strong>
                  <pre>{run.error}</pre>
                </div>
              </div>
            )}
            {detail.hasEarlierEvents && !historyComplete && (
              <Button
                onClick={async () => {
                  const older = await act(() =>
                    api(`/runs/${runId}?before=${detail.events[0].seq}`),
                  );
                  if (older) {
                    setDetail((current) => ({
                      ...current,
                      events: [
                        ...new Map(
                          [...older.events, ...current.events].map((e) => [
                            e.seq,
                            e,
                          ]),
                        ).values(),
                      ].sort((a, b) => a.seq - b.seq),
                    }));
                    if (!older.hasEarlierEvents) setHistoryComplete(true);
                  }
                }}
              >
                Load earlier activity
              </Button>
            )}
            {run.status === "queued" && (
              <div className="notice">
                <Clock3 size={16} />
                <div>
                  Waiting for an available slot
                  {run.dependencies.length
                    ? " and accepted dependency tasks"
                    : ""}
                  .
                  {state.limits
                    ? `Up to ${state.limits.concurrency} Codex sessions run at once.`
                    : "The daemon concurrency limit applies."}
                </div>
              </div>
            )}
            {!run.waitingForTask && (
              <>
                <div className="message user-message">
                  <div className="message-label">
                    <span className="avatar">Y</span>
                    <strong>
                      {run.teamRole &&
                      run.initialPrompt?.startsWith("Initial read-only")
                        ? "Fleet"
                        : "You"}
                    </strong>
                    <span>{time(run.createdAt)}</span>
                  </div>
                  <div className="message-body">
                    <MD>
                      {run.initialPrompt ||
                        (run.teamRole
                          ? `Initial read-only project assessment as ${run.teamRole}.`
                          : run.prompt)}
                    </MD>
                    {run.scopes.length > 0 && (
                      <div className="scope-list">
                        <span>Declared scope</span>
                        {run.scopes.map((s) => (
                          <code key={s}>{s}</code>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                {run.status === "draft" && (
                  <div className="start-note">
                    <GitBranch size={17} />
                    <div>
                      <strong>
                        {run.sandbox === "danger-full-access"
                          ? "YOLO runs outside the sandbox. This worktree does not restrict file or network access."
                          : run.workspaceKind === "main"
                            ? "Main working folder"
                            : "Isolated worktree"}
                      </strong>
                      <p>
                        {run.workspaceKind === "main"
                          ? "This chat uses your original project folder, including uncommitted files. It does not create a branch or isolate changes."
                          : run.worktree
                            ? "This worktree is ready on its own branch. Uncommitted source changes were not copied."
                            : "Starting creates a worktree from the latest committed revision. Your current uncommitted changes stay in the source repository."}
                      </p>
                      <span>
                        {run.workspaceKind === "main"
                          ? "Original files are shared with your other tools; Fleet does not isolate this chat."
                          : run.sandbox === "read-only"
                            ? "Codex can explore this worktree, but cannot edit source files."
                            : "Codex can edit this worktree. Network access is disabled in its sandbox."}
                      </span>
                    </div>
                  </div>
                )}
                {commands.length > 0 && (
                  <div className="command-group">
                    <button
                      aria-expanded={!!expanded.commands}
                      onClick={() =>
                        setExpanded({
                          ...expanded,
                          commands: !expanded.commands,
                        })
                      }
                    >
                      <Terminal size={14} />
                      {commands.length} command
                      {commands.length === 1 ? "" : "s"} executed
                      <ChevronDown size={14} />
                    </button>
                    {expanded.commands &&
                      commands.map((e) => (
                        <details className="terminal-entry" key={e.seq}>
                          <summary className="command-line">
                            <span
                              className={
                                e.data.item.exit_code === 0 ? "green" : "amber"
                              }
                            >
                              {e.data.item.exit_code === 0 ? "✓" : "!"}
                            </span>
                            <code>{e.data.item.command}</code>
                            <span>{e.data.item.exit_code ?? "—"}</span>
                          </summary>
                          <pre>
                            {e.data.item.aggregated_output ||
                              "No output recorded."}
                          </pre>
                        </details>
                      ))}
                  </div>
                )}
                {messages.map((e) => (
                  <div className="message" key={e.seq}>
                    <div className="message-label">
                      <span className="avatar codex-avatar">
                        <Mark small />
                      </span>
                      <strong>
                        {e.type === "run.queued"
                          ? e.data.source === "team"
                            ? "Fleet"
                            : "You"
                          : "Codex"}
                      </strong>
                      <span>{time(e.time)}</span>
                    </div>
                    <div className="message-body">
                      <MD>{e.data.prompt || e.data.item?.text}</MD>
                    </div>
                  </div>
                ))}
                {isActive && streaming && (
                  <div className="message">
                    <div className="message-body">
                      <MD>{streaming}</MD>
                    </div>
                  </div>
                )}
                {isActive && (
                  <div className="working-message">
                    <span className="working-dot" />
                    {events
                      .filter(
                        (e) =>
                          e.type === "worker.phase" &&
                          Date.parse(e.time) >= Date.parse(run.startedAt || 0),
                      )
                      .at(-1)?.data.phase || "Codex is working"}
                    <span>Events appear as they arrive</span>
                  </div>
                )}
              </>
            )}

            {run.waitingForTask && (
              <div className="conversation-empty">
                <h3>What are we working on?</h3>
                <p>Send an instruction to start.</p>
              </div>
            )}
          </div>
          {!teamReviewer &&
            !run.teamInitial &&
            [
              "draft",
              "review",
              "paused",
              "interrupted",
              "failed",
              "running",
              "preparing",
              "queued",
              "pausing",
            ].includes(run.status) && (
              <form
                className="followup"
                onSubmit={(e) => {
                  e.preventDefault();
                  start();
                }}
              >
                <textarea
                  rows={2}
                  maxLength={30000}
                  autoFocus={run.waitingForTask}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      const submit = e.currentTarget.form.querySelector(
                        'button[type="submit"]',
                      );
                      if (submit && !submit.disabled)
                        e.currentTarget.form.requestSubmit();
                    }
                  }}
                  aria-label="Follow-up instruction"
                  placeholder={
                    run.waitingForTask
                      ? "What do you want to work on?"
                      : "Continue the conversation…"
                  }
                  value={followup}
                  onChange={(e) => setFollowup(e.target.value)}
                />
                <div className="composer-bottom">
                  <button
                    type="button"
                    className="permission-control"
                    disabled={!canConfigure || busy}
                    onClick={() => setOptionsOpen(true)}
                    title={
                      canConfigure
                        ? "Change permissions and model"
                        : "Settings are locked while this session is busy or managed"
                    }
                  >
                    {run.sandbox === "danger-full-access"
                      ? "YOLO · full access"
                      : run.sandbox === "read-only"
                        ? "Read only"
                        : "Edits allowed"}{" "}
                    <ChevronDown size={11} />
                  </button>
                  <span className="composer-hint">
                    {run.waitingForTask
                      ? "Sending uses your Codex allowance"
                      : "Enter to send · Shift+Enter for a new line"}
                  </span>
                  <button
                    type="submit"
                    className="send-button"
                    disabled={
                      busy ||
                      !followup.trim() ||
                      isActive ||
                      run.status === "queued" ||
                      run.shellOpen ||
                      ["starting", "running", "stopping"].includes(
                        run.preview?.status,
                      )
                    }
                    aria-label="Send follow-up"
                  >
                    <ArrowRight size={17} />
                  </button>
                </div>
              </form>
            )}
        </section>
        {tab !== "conversation" && (
          <aside className="tool-pane" aria-label="Session tools">
            {tab !== "browser" && (
              <header className="tool-pane-heading">
                <strong>
                  {tab === "review"
                    ? "Changes & review"
                    : tab === "files"
                      ? "Files"
                      : tab === "preview"
                        ? "Preview"
                        : tab === "browser"
                          ? "Browser"
                          : tab === "terminal"
                            ? "Worktree shell"
                            : "Session details"}
                </strong>
                <button
                  aria-label="Close session tool"
                  onClick={() => setTab("conversation")}
                >
                  ×
                </button>
              </header>
            )}
            <div className="tool-scroll">
              {tab === "files" && <SessionFiles run={run} />}
              {tab === "browser" && (
                <ProjectBrowser
                  key={project.id}
                  project={project}
                  run={run}
                  browserRequestId={browserRequest?.id}
                  onClosePanel={() => setTab("conversation")}
                  onEvidence={(text) => {
                    setFollowup(text);
                    setTab("conversation");
                  }}
                />
              )}
              {tab === "preview" && (
                <Preview
                  run={run}
                  act={act}
                  onEvidence={(text) => {
                    setFollowup(text);
                    setTab("conversation");
                  }}
                />
              )}

              {tab === "terminal" && <TerminalView run={run} act={act} />}
              {tab === "review" && (
                <TeamReviews
                  project={project}
                  run={run}
                  state={state}
                  act={act}
                  goRun={goRun}
                  busy={busy}
                />
              )}
              {tab === "review" &&
                (diff?.diff ? (
                  <>
                    <div className="diff-summary">
                      <FileCode2 size={14} />
                      {diff.files.length} changed files
                      {diff.truncated && <span>Preview truncated</span>}
                    </div>
                    <div className="diff">
                      {diff.diff.split("\n").map((line, i) => (
                        <div
                          key={i}
                          className={
                            line.startsWith("+") && !line.startsWith("+++")
                              ? "added"
                              : line.startsWith("-") && !line.startsWith("---")
                                ? "removed"
                                : line.startsWith("@@")
                                  ? "hunk"
                                  : line.startsWith("diff ") ||
                                      line.startsWith("+++")
                                    ? "file-line"
                                    : ""
                          }
                        >
                          <span>{i + 1}</span>
                          <code>{line || " "}</code>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <Empty icon={FileCode2} title="No changes to inspect">
                    {run.sandbox === "read-only"
                      ? "This session can read the repository without editing files."
                      : "Changes will appear here as Codex works in its branch."}
                  </Empty>
                ))}
              {tab === "review" && (
                <>
                  <div className="check-heading">
                    <div>
                      <h3>Validation</h3>
                      <p>
                        Run your project’s check command against this worktree.
                      </p>
                    </div>
                    {project.validation ? (
                      <Button
                        icon={Play}
                        disabled={
                          teamReviewer ||
                          isActive ||
                          !run.worktree ||
                          run.status === "accepted"
                        }
                        onClick={() =>
                          act(() => api(`/runs/${runId}/validate`, "POST", {}))
                        }
                      >
                        Run checks
                      </Button>
                    ) : (
                      <Button icon={Settings2} onClick={onSettings}>
                        Set command
                      </Button>
                    )}
                  </div>
                  {project.validation && (
                    <div className="validation-command">
                      <Terminal size={14} />
                      <code>{project.validation}</code>
                      <span>Sandboxed execution</span>
                    </div>
                  )}
                  <p className="muted-copy">
                    Checks run in the worktree sandbox. An unavailable sandbox
                    blocks execution; Fleet never silently falls back to full
                    access.
                  </p>
                  {detail.validation ? (
                    <div className="check-result">
                      <span
                        className={
                          "pill " +
                          (detail.validation.status === "passed"
                            ? "green"
                            : "amber")
                        }
                      >
                        {detail.validation.status === "passed" ? (
                          <CircleCheck size={13} />
                        ) : (
                          <CircleDot size={13} />
                        )}{" "}
                        {detail.validation.status}
                      </span>
                      <pre>
                        {detail.validation.output ||
                          "Waiting for command output…"}
                      </pre>
                    </div>
                  ) : (
                    <Empty icon={CheckCheck} title="No checks run yet">
                      Fleet records exit codes and output separately from
                      Codex’s own report.
                    </Empty>
                  )}
                </>
              )}
              {tab === "review" && (
                <section className="review-section">
                  <h3>Security observations</h3>
                  <p className="muted-copy">
                    Heuristic findings are advisory, not a complete security
                    audit.
                  </p>
                  <Sentinel
                    compact
                    findings={state.findings.filter((f) => f.runId === runId)}
                    runs={[run]}
                    act={act}
                    goRun={goRun}
                  />
                  {run.status === "review" &&
                    run.workspaceKind !== "main" &&
                    !run.reviewOf &&
                    !run.teamInitial && (
                      <div className="run-controls">
                        <Button
                          primary
                          icon={Check}
                          disabled={busy}
                          onClick={() =>
                            act(
                              () => api(`/runs/${runId}/accept`, "POST", {}),
                              "Accepted on the task branch. Source branch unchanged.",
                            )
                          }
                        >
                          Accept changes
                        </Button>
                        <Button
                          icon={Eye}
                          disabled={busy}
                          onClick={async () => {
                            const r = await act(() =>
                              api(`/runs/${runId}/review`, "POST", {}),
                            );
                            if (r) goRun(r.id);
                          }}
                        >
                          Independent review
                        </Button>
                      </div>
                    )}
                </section>
              )}
              {tab === "details" && (
                <div className="session-inspector">
                  <h3>Session details</h3>
                  <dl>
                    <dt>Branch</dt>
                    <dd>{run.branch || "Created on start"}</dd>
                    <dt>Worktree</dt>
                    <dd>{run.worktree || "Not created"}</dd>
                    <dt>Permissions</dt>
                    <dd>{run.sandbox}</dd>
                    <dt>Model</dt>
                    <dd>{run.model || "Codex default"}</dd>
                    <dt>Usage</dt>
                    <dd>
                      {fmt(run.usage?.input_tokens)} input /{" "}
                      {fmt(run.usage?.output_tokens)} output
                    </dd>
                    <dt>Runtime</dt>
                    <dd>{duration(run.durationMs)}</dd>
                  </dl>
                  <h3>Context supplied to Codex</h3>
                  <pre className="context-preview">
                    {context?.text || "No context preview available."}
                  </pre>
                  <Button onClick={() => setTab("events")} icon={Activity}>
                    Execution history
                  </Button>
                </div>
              )}
              {tab === "events" && (
                <div className="event-log">
                  {events.map((e) => (
                    <details key={e.seq}>
                      <summary>
                        <span>{time(e.time)}</span>
                        <span className="event-dot" />
                        <strong>{eventTitle(e)}</strong>
                        <ChevronRight size={12} />
                      </summary>
                      <pre>{JSON.stringify(e.data, null, 2)}</pre>
                    </details>
                  ))}
                  {!events.length && (
                    <Empty icon={Activity} title="The timeline starts with you">
                      Start this session to record its events.
                    </Empty>
                  )}
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function eventTitle(e) {
  const map = {
    "run.queued": "Session queued",
    "run.started": "Codex session started",
    "thread.started": "Thread connected",
    "turn.started": "Turn started",
    "turn.completed": "Turn completed",
    "run.review": "Ready for review",
    "run.accepted": "Changes accepted",
    "run.failed": "Session failed",
    "run.paused": "Session paused",
    "brain.refreshed": "Project brain refreshed",
    "project.added": "Repository connected",
    "brain.note.saved": "Note saved",
    "sentinel.finding": "Security observation",
    "sentinel.resolved": "Security decision recorded",
    "validation.started": "Validation started",
    "validation.completed": "Validation completed",
  };
  return map[e.type] || e.data.item?.type?.replaceAll("_", " ") || e.type;
}

export { SessionLanding, RunDetail };
