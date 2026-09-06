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
function ActivityView({ projectId, state, goRun }) {
  const [events, setEvents] = useState([]);
  useEffect(() => {
    let alive = true;
    api(`/projects/${projectId}/activity`)
      .then((e) => {
        if (alive) setEvents(e);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [projectId, state]);
  return (
    <div className="full-view activity-view">
      <div className="activity-caption">
        <span>RECENT ACTIVITY</span>
        <span>Recorded locally · newest first</span>
      </div>
      {events.length ? (
        [...events].reverse().map((e) => (
          <div className="activity-row" key={e.seq}>
            <span className="activity-time">
              {date(e.time)}
              <small>{time(e.time)}</small>
            </span>
            <div
              className={
                "activity-icon " + (e.type.includes("sentinel") ? "amber" : "")
              }
            >
              {e.type.includes("brain") ? (
                <BookOpen size={15} />
              ) : e.type.includes("validation") ? (
                <CheckCheck size={15} />
              ) : e.type.includes("sentinel") ? (
                <Shield size={15} />
              ) : (
                <Terminal size={15} />
              )}
            </div>
            <div className="activity-description">
              <strong>{eventTitle(e)}</strong>
              <p>
                {e.runId ? (
                  <button onClick={() => goRun(e.runId)}>
                    {state.runs.find((r) => r.id === e.runId)?.title ||
                      e.runId.slice(0, 8)}
                    <ArrowUpRight size={12} />
                  </button>
                ) : (
                  e.data.name || e.data.filename || "Project workspace"
                )}
              </p>
            </div>
            <span className="event-seq">#{e.seq}</span>
          </div>
        ))
      ) : (
        <Empty title="Your work leaves a trail" icon={Activity}>
          Session events and project updates will appear here.
        </Empty>
      )}
    </div>
  );
}

export { ActivityView };
