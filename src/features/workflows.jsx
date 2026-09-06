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
function Missions({ missions, runs, act, goRun, onCreate }) {
  return (
    <div className="full-view mission-view">
      {!missions.length ? (
        <Empty
          icon={Layers}
          title="A bigger idea starts with a mission"
          action={
            <Button primary icon={Plus} onClick={onCreate}>
              Plan a mission
            </Button>
          }
        >
          Break a change into focused tasks. Run them in parallel, or wait for
          each dependency to be accepted.
        </Empty>
      ) : (
        missions.map((m) => {
          const tasks = runs.filter((r) => r.missionId === m.id).reverse();
          const accepted = tasks.filter((r) => r.status === "accepted").length;
          return (
            <article className="mission" key={m.id}>
              <div className="mission-header">
                <div>
                  <span className="eyebrow">
                    {m.sequential ? "SEQUENTIAL" : "PARALLEL"} MISSION{" "}
                    <span> / {date(m.createdAt)}</span>
                  </span>
                  <h2>{m.title}</h2>
                  <p>{m.objective}</p>
                </div>
                {tasks.some((r) => r.status === "draft") && (
                  <Button
                    primary
                    icon={Play}
                    onClick={() =>
                      act(() => api(`/missions/${m.id}/start`, "POST", {}))
                    }
                  >
                    Start mission
                  </Button>
                )}
              </div>
              <div className="mission-progress">
                <div style={{ width: `${(accepted / tasks.length) * 100}%` }} />
              </div>
              <div className="mission-meta">
                {accepted} of {tasks.length} tasks accepted
                <span>
                  {m.sequential
                    ? "Next task starts after its predecessor is accepted"
                    : "Independent worktrees · daemon concurrency limit applies"}
                </span>
              </div>
              <div className="mission-tasks">
                {tasks.map((t, i) => (
                  <button key={t.id} onClick={() => goRun(t.id)}>
                    <span className="task-number">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <strong>{t.title}</strong>
                    <Status status={t.status} />
                    <ArrowUpRight size={15} />
                  </button>
                ))}
              </div>
            </article>
          );
        })
      )}
      <div className="section-footnote">
        <GitBranch size={14} />
        Accepted changes stay on session branches. Integration into your source
        branch is a separate Git operation.
      </div>
    </div>
  );
}

export { Missions };
