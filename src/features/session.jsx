import React, { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
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
import { CodeExplorer } from "./code-explorer.jsx";
import {
  ChatProgress,
  ChatSearch,
  CopyButton,
  CodeBlock,
  useChatNavigation,
} from "./chat-extras.jsx";

function isToolActivity(event) {
  return (
    ["item.started", "item.completed"].includes(event.type) &&
    [
      "command_execution",
      "commandExecution",
      "file_change",
      "fileChange",
      "mcpToolCall",
    ].includes(event.data.item?.type)
  );
}

function fileDiff(change) {
  const diff = change.diff || change.unified_diff || "";
  let inHunk = false;
  let added = 0;
  let deleted = 0;
  const lines = diff.split("\n").map((text) => {
    let kind = "context";
    if (text.startsWith("diff --git ")) inHunk = false;
    if (text.startsWith("@@")) {
      inHunk = true;
      kind = "hunk";
    } else if (text.startsWith("+") && (inHunk || !text.startsWith("+++"))) {
      kind = "added";
      added++;
    } else if (text.startsWith("-") && (inHunk || !text.startsWith("---"))) {
      kind = "deleted";
      deleted++;
    }
    return { text, kind };
  });
  return { ...change, diff, lines, added, deleted };
}

function DiffCounts({ added, deleted }) {
  return (
    <span
      className="diff-counts"
      aria-label={`${added} lines added, ${deleted} lines deleted`}
    >
      <span className="diff-added">+{added}</span>
      <span className="diff-deleted">−{deleted}</span>
    </span>
  );
}

function ToolActivity({ event, active, onOpenFile }) {
  const item = event.data.item;
  const command = ["command_execution", "commandExecution"].includes(item.type);
  const files = ["file_change", "fileChange"].includes(item.type);
  const running = event.type === "item.started" && active;
  const exitCode = item.exit_code ?? item.exitCode;
  const failed =
    item.status === "failed" ||
    item.error ||
    (command && exitCode != null && exitCode !== 0);
  const status = running
    ? "Running"
    : event.type === "item.started"
      ? "Not completed"
      : failed
        ? "Failed"
        : "Completed";
  const output = item.aggregated_output ?? item.aggregatedOutput;
  const changes = files ? (item.changes || []).map(fileDiff) : [];
  const totals = changes.reduce(
    (sum, change) => ({
      added: sum.added + change.added,
      deleted: sum.deleted + change.deleted,
    }),
    { added: 0, deleted: 0 },
  );
  return (
    <div
      className="message tool-activity"
      data-event-seq={event.seq}
      data-chat-search
    >
      <div className="tool-activity-heading">
        {command ? (
          <Terminal size={15} />
        ) : files ? (
          <FileCode2 size={15} />
        ) : (
          <Activity size={15} />
        )}
        <strong>
          {command
            ? "Command"
            : files
              ? "File edits"
              : item.tool || "Tool call"}
        </strong>
        {files && changes.some((change) => change.diff) && (
          <DiffCounts {...totals} />
        )}
        <span className={failed ? "amber" : ""}>{status}</span>
        <time>{time(event.time)}</time>
      </div>
      {command && (
        <CodeBlock>
          <code className="language-bash">{item.command}</code>
        </CodeBlock>
      )}
      {command && output && (
        <details>
          <summary>
            View output{exitCode != null ? ` · exit ${exitCode}` : ""}
          </summary>
          <pre>{output}</pre>
        </details>
      )}
      {files &&
        changes.map((change, index) => (
          <details key={`${change.path}-${index}`} open>
            <summary>
              <button
                type="button"
                className="chat-file-link"
                onClick={(event) => {
                  event.preventDefault();
                  onOpenFile(
                    change.path,
                    Number(/@@.*?\+(\d+)/.exec(change.diff)?.[1]) || 1,
                  );
                }}
              >
                {change.path}
              </button>{" "}
              <span>
                {typeof change.kind === "string"
                  ? change.kind
                  : change.kind?.type}
              </span>
              {change.diff && (
                <DiffCounts added={change.added} deleted={change.deleted} />
              )}
            </summary>
            {change.diff && (
              <pre className="file-diff">
                <code>
                  {change.lines.map((line, lineIndex) => (
                    <span
                      className={`diff-line diff-line-${line.kind}`}
                      key={lineIndex}
                    >
                      {line.text || " "}
                    </span>
                  ))}
                </code>
              </pre>
            )}
          </details>
        ))}
      {!command && !files && (
        <details>
          <summary>View tool details</summary>
          <pre>
            {JSON.stringify(
              {
                arguments: item.arguments,
                result: item.result,
                error: item.error,
              },
              null,
              2,
            )}
          </pre>
        </details>
      )}
    </div>
  );
}

function ActivityGroup({ events, active, onOpenFile }) {
  const [expanded, setExpanded] = useState(false);
  const previousActive = useRef(active);
  const commands = events.filter((e) =>
    ["command_execution", "commandExecution"].includes(e.data.item.type),
  ).length;
  const edits = events.filter((e) =>
    ["file_change", "fileChange"].includes(e.data.item.type),
  );
  const paths = new Set(
    edits.flatMap((e) =>
      (e.data.item.changes || []).map((change) => change.path),
    ),
  );
  const counts = edits
    .flatMap((e) => (e.data.item.changes || []).map(fileDiff))
    .reduce(
      (total, change) => ({
        added: total.added + change.added,
        deleted: total.deleted + change.deleted,
      }),
      { added: 0, deleted: 0 },
    );
  useEffect(() => {
    // Keep finished activity open if it was visible during this reply.
    if (previousActive.current && !active) setExpanded(true);
    previousActive.current = active;
  }, [active]);
  return (
    <details
      className="chat-activity-group"
      open={active || expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <Activity size={14} />
        <strong>Activity</strong>
        <span>
          {commands} command{commands === 1 ? "" : "s"} · {paths.size} file
          {paths.size === 1 ? "" : "s"}
          {events.length > commands + edits.length
            ? ` · ${events.length - commands - edits.length} tools`
            : ""}
        </span>
        {paths.size > 0 && <DiffCounts {...counts} />}
        <ChevronDown size={14} />
      </summary>
      {events.map((event) => (
        <ToolActivity
          key={event.seq}
          event={event}
          active={active}
          onOpenFile={onOpenFile}
        />
      ))}
    </details>
  );
}

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
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const historyLoadingRef = useRef(false);
  const conversationRef = useRef(null);
  const conversationContentRef = useRef(null);
  const composerRef = useRef(null);
  const [editingMessage, setEditingMessage] = useState(null);
  const [requestedFile, setRequestedFile] = useState(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [fileError, setFileError] = useState("");
  const navigation = useChatNavigation(
    conversationRef,
    conversationContentRef,
    detail,
    historyLoadingRef,
  );
  useEffect(() => {
    localStorage.setItem(`fleet.draft.${runId}`, followup);
  }, [followup, runId]);
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
  const activityItems = new Map();
  for (const event of events) {
    if (!isToolActivity(event)) continue;
    const key = event.data.item.id || event.seq;
    const previous = activityItems.get(key);
    activityItems.set(key, { ...event, seq: previous?.seq ?? event.seq });
  }
  const messages = [
    ...events.filter(
      (e) =>
        (e.type === "item.completed" &&
          e.data.item?.type === "agent_message") ||
        (e.type === "run.queued" &&
          e.data.prompt &&
          !e.data.initialInstruction),
    ),
    ...activityItems.values(),
  ].sort((a, b) => a.seq - b.seq);
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
  const findings = state.findings.filter(
    (f) => f.runId === runId && f.state === "suspected",
  );
  const isActive = activeStatuses.includes(run.status);
  const teamReviewer = run.teamRole && run.teamRole !== "developer";
  const submitMessage = (prompt, clearDraft = true) =>
    act(() =>
      api(`/runs/${runId}/start`, "POST", { prompt: prompt || undefined }),
    ).then((r) => {
      if (r) {
        navigation.jumpLatest();
        if (clearDraft) {
          setFollowup("");
          setEditingMessage(null);
        }
      }
    });
  const start = () => submitMessage(followup);
  const canSend =
    !busy &&
    !isActive &&
    ["draft", "review", "paused", "interrupted", "failed"].includes(
      run.status,
    ) &&
    !teamReviewer &&
    !run.teamInitial &&
    !run.workflowId &&
    !run.reviewOf &&
    !run.shellOpen &&
    !["starting", "running", "stopping"].includes(run.preview?.status);
  const editMessage = (text) => {
    setEditingMessage((current) => ({ draft: current?.draft ?? followup }));
    setFollowup(text);
    composerRef.current?.focus();
  };
  const openFile = (rawPath, line = 1) => {
    try {
      let path = decodeURIComponent(rawPath)
        .replace(/^file:\/\/\/?/i, "")
        .replaceAll("\\", "/");
      const location = /(?:#L?|:)(\d+)(?::\d+)?$/.exec(path);
      if (location) {
        line = Number(location[1]);
        path = path.slice(0, location.index);
      }
      if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
      const root = (run.worktree || project.path)
        .replaceAll("\\", "/")
        .replace(/\/$/, "");
      const windows = /^[A-Za-z]:\//.test(root);
      if (
        (windows ? path.toLowerCase() : path).startsWith(
          (windows ? root.toLowerCase() : root) + "/",
        )
      )
        path = path.slice(root.length + 1);
      if (
        /^(?:\/|[A-Za-z]:|[a-z]+:)/i.test(path) ||
        path.split("/").includes("..")
      )
        throw new Error("This file is outside the session working folder.");
      path = path.replace(/^\.\//, "");
      setFileError("");
      setRequestedFile({ path, line });
    } catch (error) {
      setFileError(error.message);
    }
  };
  const closeFile = () => {
    if (editorDirty && !window.confirm("Discard your unsaved file changes?"))
      return;
    setRequestedFile(null);
    setEditorDirty(false);
  };
  const activityGroups = [];
  for (const message of messages) {
    const previous = activityGroups.at(-1);
    if (isToolActivity(message) && previous?.kind === "activity")
      previous.events.push(message);
    else
      activityGroups.push(
        isToolActivity(message)
          ? { kind: "activity", seq: message.seq, events: [message] }
          : { kind: "message", seq: message.seq, event: message },
      );
  }
  const lastUserSeq =
    events.filter((event) => event.type === "run.queued").at(-1)?.seq || 0;
  const phase =
    events
      .filter(
        (event) => event.type === "worker.phase" && event.seq > lastUserSeq,
      )
      .at(-1)?.data.phase || (run.status === "queued" ? "Queued" : "Thinking");
  const phaseSince =
    events
      .filter(
        (event) =>
          ["turn.started", "run.started"].includes(event.type) &&
          event.seq > lastUserSeq,
      )
      .at(-1)?.time ||
    run.startedAt ||
    run.createdAt;
  const loadHistory = async (all = false) => {
    if (historyLoadingRef.current) return;
    navigation.pauseFollow();
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      let cursor = detail.events[0].seq;
      let hasEarlierEvents = true;
      const events = [];
      while (hasEarlierEvents) {
        const page = await api(`/runs/${runId}?before=${cursor}`);
        events.unshift(...page.events);
        hasEarlierEvents = page.hasEarlierEvents;
        if (
          (!all &&
            page.events.some(
              (event) =>
                isToolActivity(event) ||
                (event.type === "item.completed" &&
                  event.data.item?.type === "agent_message") ||
                (event.type === "run.queued" &&
                  event.data.prompt &&
                  !event.data.initialInstruction),
            )) ||
          !hasEarlierEvents
        )
          break;
        const nextCursor = page.events[0]?.seq;
        if (!nextCursor || nextCursor >= cursor)
          throw new Error("Could not load earlier activity. Please retry.");
        cursor = nextCursor;
      }
      const feed = conversationRef.current;
      if (!feed) return;
      const feedTop = feed.getBoundingClientRect().top;
      const candidates = [...feed.querySelectorAll(".message[data-event-seq]")];
      const anchor =
        candidates.find(
          (node) => node.getBoundingClientRect().bottom > feedTop,
        ) || candidates[0];
      const anchorTop = anchor?.getBoundingClientRect().top;
      const previousScrollTop = feed.scrollTop;
      // Commit and restore together, before paint or another live update.
      flushSync(() => {
        setDetail((current) => ({
          ...current,
          events: [
            ...new Map(
              [...events, ...current.events].map((e) => [e.seq, e]),
            ).values(),
          ].sort((a, b) => a.seq - b.seq),
        }));
        if (!hasEarlierEvents) setHistoryComplete(true);
        setHistoryLoading(false);
      });
      const restoredAnchor =
        anchor &&
        feed.querySelector(`[data-event-seq="${anchor.dataset.eventSeq}"]`);
      feed.scrollTop = restoredAnchor
        ? previousScrollTop +
          restoredAnchor.getBoundingClientRect().top -
          anchorTop
        : previousScrollTop;
    } catch (error) {
      setHistoryError(error.message);
    } finally {
      historyLoadingRef.current = false;
      setHistoryLoading(false);
    }
  };
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
      {requestedFile && (
        <Dialog
          title={requestedFile.path}
          subtitle={`Session file · line ${requestedFile.line}`}
          wide
          onClose={closeFile}
        >
          <div className="chat-file-editor">
            <CodeExplorer
              key={`${runId}:${requestedFile.path}:${requestedFile.line}`}
              project={{ ...project, path: run.worktree || project.path }}
              runId={run.worktree ? runId : undefined}
              initialFile={requestedFile.path}
              initialLine={requestedFile.line}
              onDirtyChange={setEditorDirty}
            />
          </div>
        </Dialog>
      )}
      {optionsOpen && (
        <SessionOptions
          run={run}
          act={act}
          onClose={() => setOptionsOpen(false)}
        />
      )}
      <div className="run-head">
        <div className="run-title-group">
          <h2>{run.title}</h2>
          {run.sessionKind && (
            <span className="workspace-kind" title={run.worktree}>
              <GitBranch size={11} />
              {run.workspaceKind === "main" ? "Main folder" : run.branch}
            </span>
          )}
        </div>
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
          <ChatSearch
            feedRef={conversationRef}
            revision={`${events.length}:${events.at(-1)?.seq}`}
            onNavigate={navigation.pauseFollow}
            loading={historyLoading}
            complete={!detail.hasEarlierEvents || historyComplete}
            loadAll={() => loadHistory(true)}
          />
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
          <div
            ref={conversationRef}
            className="detail-scroll conversation-feed"
            onScroll={navigation.onScroll}
          >
            <div ref={conversationContentRef} className="conversation-content">
              {(run.error ||
                ["failed", "interrupted"].includes(run.status)) && (
                <div className="notice error">
                  <AlertTriangle size={16} />
                  <div>
                    <strong>Session needs attention</strong>
                    <pre>{run.error || "The reply was interrupted."}</pre>
                    {["failed", "interrupted"].includes(run.status) && (
                      <Button
                        icon={RefreshCw}
                        disabled={!canSend}
                        onClick={() =>
                          submitMessage(run.followup || run.prompt, false)
                        }
                      >
                        Retry reply
                      </Button>
                    )}
                  </div>
                </div>
              )}
              {detail.hasEarlierEvents && !historyComplete && (
                <div className="history-load-row">
                  <Button
                    className="history-load"
                    icon={historyLoading ? Loader2 : Clock3}
                    disabled={historyLoading}
                    onClick={() => loadHistory()}
                  >
                    {historyLoading
                      ? "Loading earlier activity…"
                      : "Load earlier activity"}
                  </Button>
                </div>
              )}
              {historyError && (
                <div className="notice error" role="alert">
                  {historyError}
                </div>
              )}
              {fileError && (
                <div className="notice error" role="alert">
                  {fileError}
                </div>
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
                  {(!detail.hasEarlierEvents || historyComplete) && (
                    <div
                      className="message user-message"
                      data-event-seq="initial"
                      data-chat-search
                    >
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
                        <MD onFile={openFile}>
                          {run.initialPrompt ||
                            (run.teamRole
                              ? `Initial read-only project assessment as ${run.teamRole}.`
                              : run.prompt)}
                        </MD>
                        <div className="chat-message-actions">
                          <CopyButton text={run.initialPrompt || run.prompt} />
                          {!teamReviewer && !run.teamInitial && (
                            <button
                              type="button"
                              disabled={!canSend}
                              onClick={() =>
                                editMessage(run.initialPrompt || run.prompt)
                              }
                            >
                              <Pencil size={13} />
                              Edit & resend
                            </button>
                          )}
                        </div>
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
                  )}
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
                              ? "This worktree is ready on its own branch. Changes made here stay in this working folder."
                              : "Starting creates a worktree with your current source files and uncommitted changes. Ignored files and local credentials are excluded."}
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
                  {activityGroups.map((entry) => {
                    if (entry.kind === "activity")
                      return (
                        <ActivityGroup
                          key={entry.seq}
                          events={entry.events}
                          active={isActive && entry.seq > lastUserSeq}
                          onOpenFile={openFile}
                        />
                      );
                    const e = entry.event;
                    const fromUser =
                      e.type === "run.queued" && e.data.source !== "team";
                    return (
                      <div
                        className={`message ${fromUser ? "user-message" : "codex-message"}`}
                        key={e.seq}
                        data-event-seq={e.seq}
                        data-chat-search
                      >
                        <div className="message-label">
                          <span
                            className={`avatar ${fromUser ? "" : "codex-avatar"}`}
                          >
                            {fromUser ? "Y" : <Mark small />}
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
                          <MD onFile={openFile}>
                            {e.data.prompt || e.data.item?.text}
                          </MD>
                          <div className="chat-message-actions">
                            <CopyButton
                              text={e.data.prompt || e.data.item?.text || ""}
                            />
                            {fromUser && (
                              <button
                                type="button"
                                disabled={!canSend}
                                onClick={() => editMessage(e.data.prompt)}
                              >
                                <Pencil size={13} />
                                Edit & resend
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {isActive && streaming && (
                    <div className="message codex-message streaming-message">
                      <div className="message-label">
                        <span className="avatar codex-avatar">
                          <Mark small />
                        </span>
                        <strong>Codex</strong>
                        <span>Now</span>
                      </div>
                      <div className="message-body">
                        <MD onFile={openFile}>{streaming}</MD>
                      </div>
                    </div>
                  )}
                  {isActive && (
                    <ChatProgress phase={phase} since={phaseSince} />
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
          </div>
          {navigation.away && (
            <div className="chat-jump-row">
              <button type="button" onClick={navigation.jumpLatest}>
                <ChevronDown size={15} />
                Jump to latest
              </button>
            </div>
          )}
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
                {editingMessage && (
                  <div className="chat-edit-banner">
                    <span>Edit & resend · sends a new message</span>
                    <button
                      type="button"
                      onClick={() => {
                        setFollowup(editingMessage.draft);
                        setEditingMessage(null);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                )}
                <textarea
                  ref={composerRef}
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
                    aria-label={
                      editingMessage
                        ? "Send edited follow-up"
                        : "Send follow-up"
                    }
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
