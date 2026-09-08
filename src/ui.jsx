import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./features/chat-extras.jsx";
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

import { createClient } from "../shared/client.mjs";
let client;
function getClient() {
  return (client ||= createClient({
    clientId: getClientId(),
    fetchImpl: (...args) => fetch(...args),
  }));
}
function setToken(value) {
  getClient().setToken(value);
}
async function api(path, method = "GET", data) {
  try {
    return await getClient().request(path, method, data);
  } catch (error) {
    if (error.code === "CODEX_SIGN_IN_REQUIRED")
      window.dispatchEvent(new Event("fleet:sign-in-required"));
    throw error;
  }
}
function subscribeBrowserFrames(path, onFrame, onError) {
  return getClient().subscribe(path, onFrame, onError);
}
const iconSize = 16;
function getClientId() {
  let value = sessionStorage.getItem("fleet.client");
  if (!value) {
    value = crypto.randomUUID();
    sessionStorage.setItem("fleet.client", value);
  }
  return value;
}
const activeStatuses = [
  "running",
  "preparing",
  "pausing",
  "validating",
  "accepting",
];
const labels = {
  draft: "Ready to start",
  queued: "Queued",
  preparing: "Preparing",
  running: "Working",
  pausing: "Stopping",
  paused: "Paused",
  interrupted: "Interrupted",
  review: "Needs review",
  accepted: "Accepted",
  failed: "Failed",
  cancelled: "Cancelled",
  validating: "Checking",
  accepting: "Accepting",
};
const fmt = (n) =>
  new Intl.NumberFormat("en", {
    notation: n > 9999 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(n || 0);
const time = (s) =>
  new Date(s).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
const date = (s) =>
  new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const duration = (ms) =>
  ms < 60_000
    ? `${Math.round(ms / 1000)}s`
    : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
function Status({ status, short = false }) {
  return (
    <span className={"status " + status}>
      {activeStatuses.includes(status) ? (
        <Loader2 size={12} className="spin" />
      ) : status === "accepted" ? (
        <CircleCheck size={12} />
      ) : status === "review" ? (
        <CircleDot size={12} />
      ) : status === "failed" ? (
        <AlertTriangle size={12} />
      ) : (
        <Circle size={10} />
      )}{" "}
      {!short && (labels[status] || status)}
    </span>
  );
}
function Mark({ small = false }) {
  return (
    <span className={"fleet-mark " + (small ? "small" : "")} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
function Button({
  children,
  icon: Icon,
  primary = false,
  className = "",
  ...props
}) {
  return (
    <button
      className={`${primary ? "button-primary" : "button"} ${className}`}
      {...props}
    >
      {Icon && <Icon size={14} />} {children}
    </button>
  );
}
function Empty({ icon: Icon = Layers, title, children, action }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={24} strokeWidth={1.4} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
function MD({ children, onLink, onFile }) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) =>
          onFile && /^(?:[A-Za-z]:[\\/]|file:)/i.test(url)
            ? url
            : defaultUrlTransform(url)
        }
        components={{
          pre: CodeBlock,
          a: ({ href, children }) =>
            href?.startsWith("#note:") ? (
              <button
                className="wiki-link"
                onClick={() => onLink?.(decodeURIComponent(href.slice(6)))}
              >
                {children}
              </button>
            ) : onFile && href && !/^(?:https?:|mailto:|#|\/\/)/i.test(href) ? (
              <button className="chat-file-link" onClick={() => onFile(href)}>
                {children}
              </button>
            ) : (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            ),
        }}
      >
        {String(children || "")
          .replace(/^---\n[\s\S]*?\n---\n/, "")
          .replace(
            /\[\[([^\]]+)\]\]/g,
            (_, t) => `[${t}](#note:${encodeURIComponent(t)})`,
          )}
      </Markdown>
    </div>
  );
}
function Dialog({ title, subtitle, children, onClose, wide = false }) {
  const ref = useRef();
  useEffect(() => {
    ref.current.showModal();
    ref.current
      .querySelector('input:not([type="checkbox"]), textarea, select')
      ?.focus();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={wide ? "dialog wide" : "dialog"}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export {
  api,
  subscribeBrowserFrames,
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
  MD,
  Dialog,
  Field,
};
