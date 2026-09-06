import React, { useEffect, useRef, useState } from "react";
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
import "./style.css";
import "./focus.css";
import "./home.css";

import {
  api,
  setToken,
  activeStatuses,
  fmt,
  time,
  date,
  duration,
  Status,
  Mark,
  Button,
  Empty,
} from "./ui.jsx";
import { SessionLanding, RunDetail } from "./features/session.jsx";
import { BrainView } from "./features/brain.jsx";
import { Sentinel } from "./features/security.jsx";
import { Missions } from "./features/workflows.jsx";
import { WorkflowPlanner } from "./features/workflow-planner.jsx";
import { ActivityView } from "./features/activity.jsx";
import {
  ProjectDialog,
  RunDialog,
  MissionDialog,
  SettingsDialog,
  SearchDialog,
} from "./features/dialogs.jsx";
import { MD, Dialog } from "./ui.jsx";
import { TeamStrip } from "./features/team.jsx";
import { ProjectStart } from "./features/onboarding.jsx";
import {
  WorkspaceSidebar,
  DeleteSessionDialog,
  SessionTrash,
} from "./features/workspace.jsx";
import { HomePage } from "./features/home.jsx";
import { ProjectNavigation } from "./features/project-navigation.jsx";
import { TerminalView } from "./features/terminal.jsx";
function App() {
  const [state, setState] = useState(null);
  const [showExamples, setShowExamples] = useState(
    () => localStorage.getItem("fleet.show-examples") === "true",
  );
  const [projectId, setProjectId] = useState(() =>
    localStorage.getItem("fleet.project"),
  );
  const [view, setView] = useState("home");
  const [allProjects, setAllProjects] = useState(false);
  const [closedProjectTabs, setClosedProjectTabs] = useState(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem("fleet.closed-project-tabs") || "[]",
      );
      return Array.isArray(saved)
        ? saved.filter((id) => typeof id === "string")
        : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    localStorage.setItem(
      "fleet.closed-project-tabs",
      JSON.stringify(closedProjectTabs),
    );
  }, [closedProjectTabs]);
  useEffect(() => {
    if (view !== "home" && !allProjects && projectId) {
      setClosedProjectTabs((ids) =>
        ids.includes(projectId) ? ids.filter((id) => id !== projectId) : ids,
      );
    }
  }, [projectId, view, allProjects]);
  const [selected, setSelected] = useState(() =>
    localStorage.getItem("fleet.session"),
  );
  const [lastConversation, setLastConversation] = useState(
    () =>
      localStorage.getItem("fleet.last-conversation") ||
      localStorage.getItem("fleet.session"),
  );
  const [listOpen, setListOpen] = useState(
    () => localStorage.getItem("fleet.list") !== "closed",
  );
  useEffect(() => {
    localStorage.setItem("fleet.project", projectId || "");
  }, [projectId]);
  useEffect(() => {
    localStorage.setItem("fleet.view", view);
  }, [view]);
  useEffect(() => {
    localStorage.setItem("fleet.session", selected || "");
  }, [selected]);
  useEffect(() => {
    localStorage.setItem("fleet.list", listOpen ? "open" : "closed");
  }, [listOpen]);
  const [modal, setModal] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const deletingSession = useRef(false);
  const openingSession = useRef(false);
  const openConversation = async (id = projectId, kind) => {
    if (openingSession.current || !state) return;
    openingSession.current = true;
    try {
      const target = state.projects.find((p) => p.id === id);
      const run = await act(() =>
        kind
          ? api("/sessions/new", "POST", {
              projectId: id,
              kind,
              approved: true,
            })
          : api("/sessions/quick", "POST", {
              projectId: target?.kind === "scratch" ? null : id,
              approved: true,
              useTeam: false,
              prompt: "",
            }),
      );
      if (run) {
        setProjectId(run.projectId);
        setSelected(run.id);
        localStorage.setItem(`fleet.selection.${run.projectId}`, run.id);
        setView("sessions");
        setModal(null);
      }
    } finally {
      openingSession.current = false;
    }
  };
  const [requestedNote, setRequestedNote] = useState(null);
  const [filePreview, setFilePreview] = useState(null);
  const [toast, setToast] = useState(null);
  const [offline, setOffline] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const toastTimer = useRef();
  const notify = (message, error = false) => {
    setToast({ message, error });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 6500);
  };
  const refresh = async () => {
    try {
      const s = await api("/state");
      setToken(s.csrf);
      setState(s);
      const linkedId = location.hash.startsWith("#session=")
        ? decodeURIComponent(location.hash.slice(9))
        : null;
      if (linkedId && s.runs.some((r) => r.id === linkedId)) {
        if (
          s.projects.find(
            (p) => p.id === s.runs.find((r) => r.id === linkedId).projectId,
          )?.example
        ) {
          localStorage.setItem("fleet.show-examples", "true");
          setShowExamples(true);
        }
        setSelected(linkedId);
        setProjectId(s.runs.find((r) => r.id === linkedId).projectId);
        setView("sessions");
        history.replaceState(null, "", location.pathname);
      }
      setProjectId((p) =>
        s.projects.some(
          (v) =>
            v.id === p &&
            (!v.example ||
              localStorage.getItem("fleet.show-examples") === "true"),
        )
          ? p
          : s.projects.find(
              (v) =>
                !v.example ||
                localStorage.getItem("fleet.show-examples") === "true",
            )?.id || null,
      );
      setOffline(false);
    } catch (e) {
      setOffline(true);
    }
  };
  useEffect(() => {
    refresh();
    const stream =
      typeof EventSource === "undefined"
        ? null
        : new EventSource("/api/stream");
    let update;
    if (stream) {
      stream.addEventListener("change", () => {
        clearTimeout(update);
        update = setTimeout(refresh, 120);
      });
      stream.addEventListener("open", refresh);
      stream.addEventListener("error", () => setOffline(true));
    }
    const t = setInterval(refresh, 30_000);
    return () => {
      clearInterval(t);
      stream?.close();
      clearTimeout(update);
      clearTimeout(toastTimer.current);
    };
  }, []);
  useEffect(() => {
    const listener = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setModal("search");
      }
      if (e.key === "Escape") setSearch("");
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        if (!modal && !deleteTarget && !e.repeat)
          openConversation(view === "home" ? null : projectId);
      }
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [state, projectId, modal, view, deleteTarget]);
  useEffect(() => {
    const closeMenus = (e) => {
      document
        .querySelectorAll(".project-menu[open], .tools-menu[open]")
        .forEach((menu) => {
          if (
            e.key === "Escape" ||
            (e.type === "pointerdown" && !menu.contains(e.target))
          )
            menu.open = false;
        });
    };
    document.addEventListener("pointerdown", closeMenus);
    document.addEventListener("keydown", closeMenus);
    return () => {
      document.removeEventListener("pointerdown", closeMenus);
      document.removeEventListener("keydown", closeMenus);
    };
  }, []);
  const act = async (fn, message) => {
    setBusy(true);
    try {
      const result = await fn();
      await refresh();
      if (message) notify(message);
      return result;
    } catch (e) {
      notify(e.message, true);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const project = state?.projects.find((p) => p.id === projectId);
  const team = state?.teams?.find((t) => t.projectId === projectId);
  const runs = state?.runs.filter((r) => r.projectId === projectId) || [];
  const listedRuns = runs.filter(
    (r) => !r.teamRole || r.teamRole === "developer",
  );
  const deletedRuns = (state?.deletedRuns || []).filter(
    (r) =>
      (allProjects || r.projectId === projectId) &&
      state.projects.some(
        (p) => p.id === r.projectId && (!p.example || showExamples),
      ),
  );
  const deleteConversation = async () => {
    if (!deleteTarget || deletingSession.current) return;
    deletingSession.current = true;
    try {
      const result = await act(
        () => api(`/runs/${deleteTarget.id}`, "DELETE", { approved: true }),
        "Moved to Trash. History and files kept; restore it from Trash.",
      );
      if (result) {
        if (selected === deleteTarget.id) setSelected(null);
        if (
          localStorage.getItem(`fleet.selection.${deleteTarget.projectId}`) ===
          deleteTarget.id
        )
          localStorage.removeItem(`fleet.selection.${deleteTarget.projectId}`);
        if (lastConversation === deleteTarget.id) {
          setLastConversation(null);
          localStorage.removeItem("fleet.last-conversation");
        }
        setDeleteTarget(null);
      }
    } finally {
      deletingSession.current = false;
    }
  };
  const missions =
    state?.missions.filter((m) => m.projectId === projectId) || [];
  const findings =
    state?.findings.filter((f) => f.projectId === projectId) || [];
  const openFindings = findings.filter((f) => f.state === "suspected");
  useEffect(() => {
    const run = state?.runs.find((r) => r.id === selected);
    if (
      view !== "home" &&
      run &&
      !run.reviewOf &&
      run.sessionKind !== "terminal" &&
      !run.teamInitial &&
      (!run.teamRole || run.teamRole === "developer")
    ) {
      setLastConversation(run.id);
      localStorage.setItem("fleet.last-conversation", run.id);
    }
  }, [selected, state, view]);
  useEffect(() => {
    if (view !== "home" && !runs.some((r) => r.id === selected)) {
      const chats = listedRuns.filter(
        (r) => !r.reviewOf && r.sessionKind !== "terminal",
      );
      const preferred = chats.find((r) => r.status !== "draft") || chats[0];
      setSelected(preferred?.id || null);
    }
  }, [projectId, state, selected, view]);
  const chooseProject = (id) => {
    if (id === projectId) return;
    setProjectId(id);
    setSelected(localStorage.getItem(`fleet.selection.${id}`) || null);
    setSearch("");
  };
  const openProject = (id) => {
    setClosedProjectTabs((ids) => ids.filter((closed) => closed !== id));
    setAllProjects(false);
    setListOpen(true);
    chooseProject(id);
    setView("sessions");
  };
  const goRun = (key) => {
    setSelected(key);
    const target = state?.runs.find((r) => r.id === key);
    if (target) {
      setProjectId(target.projectId);
      localStorage.setItem(`fleet.selection.${target.projectId}`, key);
    }
    setView("sessions");
    setSearch("");
  };
  if (!state)
    return (
      <div className="boot">
        <Mark />
        <span>
          {offline
            ? "Fleet is offline. Start the local server to reconnect."
            : "Opening your workspace…"}
        </span>
        {offline && <Button onClick={refresh}>Retry</Button>}
      </div>
    );
  return (
    <div className="app simple-app">
      <div className="workspace focused-workspace">
        <header className="workspace-bar">
          <ProjectNavigation
            projects={state.projects.filter((p) => !p.example || showExamples)}
            closedProjectTabs={closedProjectTabs}
            onClose={(id) => {
              setClosedProjectTabs((ids) => [...new Set([...ids, id])]);
              if (view !== "home" && !allProjects && projectId === id)
                setView("home");
            }}
            onNew={() => setModal("new-project")}
            onOpen={() => setModal("folder")}
            busy={busy}
            projectId={projectId}
            view={view}
            allProjects={allProjects}
            onHome={() => setView("home")}
            onAll={() => {
              setAllProjects(true);
              setListOpen(true);
              setView("sessions");
            }}
            onProject={openProject}
          />
          {view !== "home" && (
            <>
              <button
                className="brain-shortcut"
                aria-label="Project brain"
                aria-pressed={view === "brain"}
                disabled={!project}
                onClick={() => setView(view === "brain" ? "sessions" : "brain")}
              >
                <Network size={15} />
                Brain
              </button>
              <button
                className="icon-button"
                disabled={view === "brain"}
                aria-label={
                  listOpen ? "Hide session list" : "Show session list"
                }
                aria-expanded={listOpen}
                onClick={() => setListOpen(!listOpen)}
              >
                <PanelLeftClose size={17} />
              </button>
              <details className="project-menu" key={projectId || "workspace"}>
                <summary aria-label="Project tools" title="Project tools">
                  <MoreHorizontal size={17} />
                </summary>
                <div
                  className="workspace-menu"
                  onClick={(e) => {
                    if (e.target.closest("button:not(:disabled)"))
                      e.currentTarget.closest("details").open = false;
                  }}
                >
                  {project && (
                    <div className="project-menu-context">
                      For {project.name}
                    </div>
                  )}
                  <button onClick={() => setView("sessions")}>
                    Conversations
                  </button>
                  <hr />
                  <button disabled={!project} onClick={() => setView("brain")}>
                    Project memory
                  </button>
                  <button
                    disabled={!project}
                    onClick={() => setView("missions")}
                  >
                    Workflows
                  </button>
                  <button
                    disabled={!project}
                    onClick={() => setView("attention")}
                  >
                    Activity & attention
                  </button>
                  <button
                    disabled={!project}
                    onClick={() => setView("sentinel")}
                  >
                    Security
                  </button>
                  <button onClick={() => setModal("settings")}>
                    Project settings…
                  </button>
                </div>
              </details>
            </>
          )}
          <span className="bar-spacer" />
          {view === "home" && (
            <button
              className="icon-button"
              aria-label="Settings"
              onClick={() => setModal("settings")}
            >
              <Settings2 size={16} />
            </button>
          )}
          <button
            className="icon-button"
            aria-label="Search workspace"
            title="Search (⌘K)"
            onClick={() => setModal("search")}
          >
            <Search size={16} />
          </button>
          {view !== "home" && !listOpen && (
            <Button
              icon={Plus}
              disabled={busy}
              onClick={() => openConversation()}
            >
              New conversation
            </Button>
          )}
        </header>
        {offline && (
          <div className="offline">
            Connection lost. Your saved sessions are safe; reconnecting to the
            local server.
          </div>
        )}
        {view === "home" ? (
          <HomePage
            state={state}
            selected={lastConversation}
            showExamples={showExamples}
            onProject={openProject}
            onContinue={(id) => {
              setAllProjects(false);
              goRun(id);
            }}
            onNew={() => setModal("new-project")}
            onOpen={() => setModal("folder")}
            onScratch={() => openConversation(null)}
            busy={busy}
          />
        ) : (
          <div className="workspace-body">
            {listOpen && view !== "brain" && (
              <WorkspaceSidebar
                key={allProjects ? "all-projects" : projectId || "workspace"}
                state={state}
                allProjects={allProjects}
                projectId={projectId}
                selected={selected}
                showExamples={showExamples}
                goRun={goRun}
                chooseProject={openProject}
                onNew={openConversation}
                onDelete={setDeleteTarget}
                onTrash={() => setModal("trash")}
                trashCount={deletedRuns.length}
                busy={busy}
              />
            )}
            <div className="workspace-content">
              {!project ? (
                <Welcome
                  onAdd={() => setModal("folder")}
                  onNew={() => openConversation(null)}
                />
              ) : (
                <>
                  {view !== "sessions" && view !== "brain" && (
                    <div className="focus-page-heading">
                      <h1>
                        {view === "brain"
                          ? "Project brain"
                          : view === "missions"
                            ? "Workflows"
                            : view === "attention"
                              ? "Attention"
                              : view === "sentinel"
                                ? "Security"
                                : "Activity"}
                      </h1>
                      <p>
                        {view === "attention"
                          ? "Only the things that need you."
                          : view === "brain"
                            ? "Project knowledge, with sources."
                            : view === "missions"
                              ? "Review the plan. Let Codex do the work."
                              : ""}
                      </p>
                    </div>
                  )}
                  {view === "sessions" && (
                    <section className="detail-column">
                      {selected && runs.some((r) => r.id === selected) ? (
                        state.runs.find((r) => r.id === selected)
                          ?.sessionKind === "terminal" ? (
                          <div className="standalone-terminal">
                            <TerminalView
                              standalone
                              key={selected}
                              run={state.runs.find((r) => r.id === selected)}
                              act={act}
                            />
                          </div>
                        ) : (
                          <RunDetail
                            key={selected}
                            runId={selected}
                            project={project}
                            state={state}
                            act={act}
                            busy={busy}
                            goRun={goRun}
                            onSettings={() => setModal("settings")}
                          />
                        )
                      ) : (
                        <SessionLanding
                          runs={runs}
                          onSelect={setSelected}
                          onCreate={() => openConversation()}
                          project={project}
                        />
                      )}
                    </section>
                  )}
                  {view === "attention" && (
                    <div className="attention-list">
                      {team?.reason && (
                        <button
                          className="attention-row"
                          onClick={() => setModal("settings")}
                        >
                          <strong>Project team</strong>
                          <p>{team.reason}</p>
                        </button>
                      )}
                      {(state.teamRounds || [])
                        .filter(
                          (r) =>
                            r.projectId === projectId &&
                            ["failed", "stale"].includes(r.status),
                        )
                        .map((r) => (
                          <button
                            className="attention-row"
                            key={r.id}
                            onClick={() => goRun(r.targetRunId)}
                          >
                            <strong>Team review {r.status}</strong>
                            <p>
                              {r.error ||
                                "Inspect the report and explicitly request a new review."}
                            </p>
                          </button>
                        ))}
                      {runs
                        .filter(
                          (r) =>
                            [
                              "review",
                              "failed",
                              "interrupted",
                              "paused",
                            ].includes(r.status) || r.blockedReason,
                        )
                        .map((r) => (
                          <button
                            className="attention-row"
                            key={r.id}
                            onClick={() => goRun(r.id)}
                          >
                            <Status status={r.status} short />
                            <div>
                              <strong>{r.title}</strong>
                              <p>
                                {r.blockedReason ||
                                  r.error ||
                                  (r.status === "review"
                                    ? "Inspect changes and current checks."
                                    : "Choose whether to resume this session.")}
                              </p>
                            </div>
                            <ArrowUpRight size={17} />
                          </button>
                        ))}
                      {!runs.some(
                        (r) =>
                          [
                            "review",
                            "failed",
                            "interrupted",
                            "paused",
                          ].includes(r.status) || r.blockedReason,
                      ) && (
                        <Empty
                          icon={CheckCheck}
                          title="Nothing needs your attention"
                        >
                          Your sessions will appear here when a decision is
                          needed.
                        </Empty>
                      )}
                      {openFindings.length > 0 && (
                        <Button
                          icon={Shield}
                          onClick={() => setView("sentinel")}
                        >
                          Review {openFindings.length} security observations
                        </Button>
                      )}
                    </div>
                  )}
                  {view === "missions" && (
                    <>
                      <WorkflowPlanner
                        openRequest={modal === "workflow"}
                        onOpenHandled={() => setModal(null)}
                        project={project}
                        state={state}
                        act={act}
                        goRun={goRun}
                      />
                      {missions.length > 0 && (
                        <details className="legacy-missions">
                          <summary>Earlier missions</summary>
                          <Missions
                            missions={missions}
                            runs={runs}
                            act={act}
                            goRun={goRun}
                            onCreate={() => setModal("mission")}
                          />
                        </details>
                      )}
                    </>
                  )}
                  {view === "brain" && (
                    <BrainView
                      key={projectId}
                      requestedNote={requestedNote}
                      project={project}
                      act={act}
                      state={state}
                      notify={notify}
                    />
                  )}
                  {view === "sentinel" && (
                    <Sentinel
                      findings={findings}
                      runs={runs}
                      act={act}
                      goRun={goRun}
                    />
                  )}
                  {view === "activity" && (
                    <ActivityView
                      projectId={projectId}
                      state={state}
                      goRun={goRun}
                    />
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
      {deleteTarget && (
        <DeleteSessionDialog
          run={state.runs.find((r) => r.id === deleteTarget.id) || deleteTarget}
          busy={busy}
          onClose={() => {
            if (!deletingSession.current) setDeleteTarget(null);
          }}
          onDelete={deleteConversation}
        />
      )}
      {modal === "trash" && (
        <SessionTrash
          runs={deletedRuns}
          projects={state.projects}
          busy={busy}
          onClose={() => setModal(null)}
          onRestore={(id) =>
            act(
              () => api(`/runs/${id}/restore`, "POST", {}),
              "Chat restored. No agent or shell was started.",
            )
          }
        />
      )}
      {toast && (
        <div role="status" className={"toast " + (toast.error ? "error" : "")}>
          {toast.error ? <AlertTriangle size={16} /> : <Check size={16} />}
          <span>{toast.message}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {(modal === "project" || modal === "folder" || modal === "new-project") &&
        React.createElement(
          modal === "project" ? ProjectStart : ProjectDialog,
          {
            key: modal,
            initialMode: modal === "new-project" ? "create" : "open",
            teamConfig: state.teamConfig,
            busy,
            onClose: () => setModal(null),
            onSave: async (input) => {
              const p = await act(() => api("/projects", "POST", input));
              if (p) {
                openProject(p.id);
                if (p.firstRunId) goRun(p.firstRunId);
                if (p.setupError) notify(p.setupError, true);
                setModal(null);
              }
            },
          },
        )}
      {modal === "advanced-run" && project && (
        <RunDialog
          project={project}
          team={team}
          onClose={() => setModal(null)}
          busy={busy}
          onSave={async (input, start) => {
            const run = await act(() =>
              api(
                `/projects/${projectId}/${input.useTeam ? "team/task" : "runs"}`,
                "POST",
                input,
              ),
            );
            if (run) {
              localStorage.removeItem(
                `fleet.new-session.${project.id || project.name}`,
              );
              setModal(null);
              goRun(run.id);
              if (start && !input.useTeam)
                await act(() => api(`/runs/${run.id}/start`, "POST", {}));
            }
          }}
        />
      )}
      {modal === "mission" && project && (
        <MissionDialog
          onClose={() => setModal(null)}
          busy={busy}
          onSave={async (input) => {
            const result = await act(() =>
              api(`/projects/${projectId}/missions`, "POST", input),
            );
            if (result) setModal(null);
          }}
        />
      )}
      {modal === "settings" && (
        <SettingsDialog
          state={state}
          showExamples={showExamples}
          onShowExamples={(value) => {
            localStorage.setItem("fleet.show-examples", String(value));
            setShowExamples(value);
            if (!value && project?.example)
              chooseProject(state.projects.find((p) => !p.example)?.id || null);
          }}
          project={view === "home" ? null : project}
          onClose={() => setModal(null)}
          act={act}
          busy={busy}
        />
      )}
      {modal === "search" && (
        <SearchDialog
          runs={state.runs.filter(
            (r) =>
              showExamples ||
              !state.projects.find((p) => p.id === r.projectId)?.example,
          )}
          showExamples={showExamples}
          onResult={async (result) => {
            setProjectId(result.projectId);
            setModal(null);
            if (result.kind === "note") {
              setRequestedNote(result.filename);
              setView("brain");
            } else if (result.kind === "workflow") setView("missions");
            else if (result.kind === "file") {
              const preview = await act(() =>
                api(
                  `/projects/${result.projectId}/file?path=${encodeURIComponent(result.path)}`,
                ),
              );
              if (preview) setFilePreview(preview);
            }
          }}
          onClose={() => setModal(null)}
          goRun={(key) => {
            goRun(key);
            setModal(null);
          }}
          navigate={(v) => {
            setView(v);
            setModal(null);
          }}
          onCreate={() => openConversation(view === "home" ? null : projectId)}
        />
      )}
      {filePreview && (
        <Dialog
          title={filePreview.path}
          subtitle={`Committed source · ${filePreview.revision.slice(0, 12)}${filePreview.truncated ? " · truncated" : ""}`}
          wide
          onClose={() => setFilePreview(null)}
        >
          <pre className="file-preview">{filePreview.content}</pre>
        </Dialog>
      )}
    </div>
  );
}

function Welcome({ onAdd, onNew }) {
  return (
    <main className="welcome">
      <div className="welcome-copy">
        <Mark />
        <h1>What are we working on?</h1>
        <p>Open a project, or start a conversation without one.</p>
        <div className="welcome-actions">
          <Button primary onClick={onNew}>
            Start a conversation
          </Button>
          <Button onClick={onAdd}>Add a project</Button>
        </div>
      </div>
    </main>
  );
}
export { App, MD, RunDialog, MissionDialog, Sentinel, BrainView };
const rootElement = document.getElementById("root");
if (rootElement) createRoot(rootElement).render(<App />);
