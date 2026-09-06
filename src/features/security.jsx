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
function Sentinel({ findings, runs, act, goRun, compact = false }) {
  const [filter, setFilter] = useState("open");
  const [decision, setDecision] = useState(null);
  const [reason, setReason] = useState("");
  const [resolution, setResolution] = useState("accepted-risk");
  const visible = findings.filter(
    (f) => filter === "all" || f.state === "suspected",
  );
  return (
    <div className={"full-view sentinel-view " + (compact ? "compact" : "")}>
      {!compact && (
        <>
          <div className="sentinel-banner">
            <div className="sentinel-emblem">
              <ShieldCheck size={27} strokeWidth={1.3} />
            </div>
            <div>
              <h2>Security review</h2>
              <p>
                Sentinel scans changed text files and Codex command events.
                Findings are review signals backed by a source location.
              </p>
            </div>
            <span className="pill green">
              <span className="connection-dot" />
              Event + diff checks
            </span>
          </div>
          <div className="security-boundary">
            <div>
              <strong>Enforced by Codex</strong>
              <span>
                Selected sandbox · workspace network disabled · no unattended
                escalation
              </span>
            </div>
            <div>
              <strong>Observed by Sentinel</strong>
              <span>
                Changed files · credential patterns · command events · declared
                scope
              </span>
            </div>
            <p>
              Command events arrive after dispatch. This release does not
              intercept commands or inspect all network traffic. Findings remain
              suspected until you investigate them.
            </p>
          </div>
        </>
      )}
      <div className="findings-toolbar">
        <h3>
          Observations{" "}
          <span>{findings.filter((f) => f.state === "suspected").length}</span>
        </h3>
        <div className="segmented">
          <button
            className={filter === "open" ? "selected" : ""}
            onClick={() => setFilter("open")}
          >
            Open
          </button>
          <button
            className={filter === "all" ? "selected" : ""}
            onClick={() => setFilter("all")}
          >
            All history
          </button>
        </div>
      </div>
      {visible.length ? (
        visible.map((f) => (
          <article className="finding" key={f.id}>
            <div className="finding-head">
              <span className={"severity " + f.severity}>{f.severity}</span>
              <strong>{f.title}</strong>
              <span className="finding-state">{f.state}</span>
            </div>
            <div className="finding-source">
              <FileCode2 size={13} />
              {f.path}
              {f.line ? `:${f.line}` : ""}
              <span>·</span>
              <button onClick={() => goRun(f.runId)}>
                {runs.find((r) => r.id === f.runId)?.title || "Session"}
                <ArrowUpRight size={12} />
              </button>
            </div>
            <pre>{f.evidence}</pre>
            <p>{f.advice}</p>
            {f.reason && (
              <div className="decision-reason">Decision: {f.reason}</div>
            )}
            {f.state === "suspected" && (
              <Button
                onClick={() => {
                  setDecision(f);
                  setReason("");
                  setResolution("accepted-risk");
                }}
              >
                Record decision
              </Button>
            )}
          </article>
        ))
      ) : (
        <Empty
          icon={Shield}
          title={
            filter === "open" ? "Nothing flagged" : "No observations recorded"
          }
        >
          Sentinel will show matching patterns from session changes here. An
          empty list does not certify that the code is secure.
        </Empty>
      )}
      <div className="section-footnote">
        Rules currently cover credential patterns, TLS verification, dynamic
        evaluation, shell execution, CORS, privileged runtimes, and declared
        file scopes.
      </div>
      {decision && (
        <Dialog
          title="Record your decision"
          subtitle={decision.title}
          onClose={() => setDecision(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const f = await act(
                () =>
                  api(`/findings/${decision.id}`, "PATCH", {
                    state: resolution,
                    reason,
                  }),
                "Security decision recorded.",
              );
              if (f) setDecision(null);
            }}
          >
            <Field label="Resolution">
              <select
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
              >
                <option value="accepted-risk">
                  Accept risk with explanation
                </option>
                <option value="false-positive">Mark as false positive</option>
              </select>
            </Field>
            <Field label="Reason">
              <textarea
                required
                rows={4}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="What did you verify, and why is this acceptable?"
              />
            </Field>
            <div className="dialog-actions">
              <Button type="button" onClick={() => setDecision(null)}>
                Cancel
              </Button>
              <Button primary type="submit">
                Save decision
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}

export { Sentinel };
