import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Plus,
  RefreshCw,
  Save,
  Search,
  X,
} from "lucide-react";
import { api } from "../ui.jsx";
import "../code-explorer.css";

const codeExtensions = new Set([
  "c",
  "cc",
  "cpp",
  "cs",
  "css",
  "go",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "jsx",
  "json",
  "kt",
  "lua",
  "mjs",
  "php",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svelte",
  "swift",
  "ts",
  "tsx",
  "vue",
  "xml",
  "yaml",
  "yml",
]);

const extension = (path) => path.split(".").pop()?.toLowerCase() || "";
const isCode = (path) => codeExtensions.has(extension(path));

// Keep drafts outside the editor's lifetime, including session-file dialogs.
// Session storage also survives a reload; memory is a fallback if it is full.
const draftFallback = new Map();
const pendingSaves = new Map();
const draftEvent = "fleet:code-draft";
function readDraft(key) {
  try {
    const draft = JSON.parse(
      draftFallback.get(key) || sessionStorage.getItem(key) || "null",
    );
    return typeof draft?.content === "string" &&
      typeof draft?.savedContent === "string"
      ? draft
      : null;
  } catch {
    return null;
  }
}
function writeDraft(key, draft) {
  const value = JSON.stringify(draft);
  try {
    sessionStorage.setItem(key, value);
    draftFallback.delete(key);
  } catch {
    draftFallback.set(key, value);
  }
  window.dispatchEvent(new CustomEvent(draftEvent, { detail: { key, draft } }));
}
const sortNodes = (nodes) =>
  nodes
    .sort(
      (a, b) =>
        Number(b.type === "folder") - Number(a.type === "folder") ||
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    )
    .map((node) => ({
      ...node,
      children: node.children ? sortNodes(node.children) : undefined,
    }));

export function buildFileTree(files) {
  const root = [];
  for (const path of files) {
    const parts = path.split("/").filter(Boolean);
    let children = root;
    parts.forEach((name, index) => {
      const nodePath = parts.slice(0, index + 1).join("/");
      const folder = index < parts.length - 1;
      let node = children.find((item) => item.name === name);
      if (!node) {
        node = {
          name,
          path: nodePath,
          type: folder ? "folder" : "file",
          ...(folder ? { children: [] } : {}),
        };
        children.push(node);
      }
      if (folder) children = node.children;
    });
  }
  return sortNodes(root);
}

function FileIcon({ path, size = 14 }) {
  return isCode(path) ? (
    <FileCode2 size={size} aria-hidden="true" />
  ) : (
    <FileText size={size} aria-hidden="true" />
  );
}

function TreeNode({ node, depth, expanded, selected, onToggle, onSelect }) {
  const open = expanded.has(node.path);
  if (node.type === "folder")
    return (
      <li>
        <button
          className="code-tree-row code-folder-row"
          style={{ "--tree-depth": depth }}
          aria-label={`${open ? "Collapse" : "Expand"} ${node.path}`}
          aria-expanded={open}
          onClick={() => onToggle(node.path)}
        >
          {open ? (
            <ChevronDown size={13} aria-hidden="true" />
          ) : (
            <ChevronRight size={13} aria-hidden="true" />
          )}
          {open ? (
            <FolderOpen size={14} aria-hidden="true" />
          ) : (
            <Folder size={14} aria-hidden="true" />
          )}
          <span>{node.name}</span>
        </button>
        {open && (
          <ul>
            {node.children.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                expanded={expanded}
                selected={selected}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
      </li>
    );
  return (
    <li>
      <button
        className={`code-tree-row code-file-row ${selected === node.path ? "selected" : ""}`}
        style={{ "--tree-depth": depth }}
        aria-label={`Open ${node.path}`}
        aria-current={selected === node.path ? "page" : undefined}
        onClick={() => onSelect(node.path)}
      >
        <span className="code-tree-file-spacer" />
        <FileIcon path={node.path} />
        <span>{node.name}</span>
      </button>
    </li>
  );
}

export function CodeExplorer(props) {
  return (
    <CodeEditor
      key={JSON.stringify([props.project.id, props.project.path, props.runId])}
      {...props}
    />
  );
}

function CodeEditor({
  project,
  runId,
  initialFile,
  initialLine = 1,
  onDirtyChange,
}) {
  const storageKey = `fleet.code-file.${runId || project.id}`;
  const endpoint = `/projects/${project.id}/files${runId ? `?runId=${encodeURIComponent(runId)}` : ""}`;
  const draftKey = (path) =>
    `fleet.code-draft.${JSON.stringify([project.id, project.path, runId || "", path])}`;
  const editorRef = useRef(null);
  const locationApplied = useRef(false);
  const [files, setFiles] = useState(null);
  const [selected, setSelected] = useState(
    () => initialFile || localStorage.getItem(storageKey) || "",
  );
  const documentKey = draftKey(selected);
  const [expanded, setExpanded] = useState(new Set());
  const [query, setQuery] = useState("");
  const [content, setContent] = useState(null);
  const [savedContent, setSavedContent] = useState(null);
  const [listError, setListError] = useState("");
  const [contentError, setContentError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createKind, setCreateKind] = useState("");
  const [newPath, setNewPath] = useState("");
  const dirty =
    content !== null && savedContent !== null && content !== savedContent;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (
      locationApplied.current ||
      content === null ||
      !editorRef.current ||
      selected !== initialFile
    )
      return;
    const lines = content.split("\n");
    const line = Math.min(Math.max(1, initialLine), lines.length);
    const offset = lines
      .slice(0, line - 1)
      .reduce((sum, text) => sum + text.length + 1, 0);
    const editor = editorRef.current;
    editor.focus();
    editor.setSelectionRange(offset, offset + lines[line - 1].length);
    const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 22;
    editor.scrollTop = Math.max(
      0,
      (line - 1) * lineHeight - editor.clientHeight / 3,
    );
    locationApplied.current = true;
  }, [content, initialFile, initialLine, selected]);

  useEffect(() => {
    let alive = true;
    setFiles(null);
    setListError("");
    api(endpoint)
      .then((result) => {
        if (!alive) return;
        setFiles(result);
        setSelected((current) => {
          const draft = readDraft(draftKey(current));
          if (
            !current ||
            current === initialFile ||
            result.files.includes(current) ||
            draft?.content !== draft?.savedContent ||
            draft?.error ||
            pendingSaves.has(draftKey(current))
          )
            return current;
          localStorage.removeItem(storageKey);
          return "";
        });
      })
      .catch((error) => {
        if (alive) setListError(error.message);
      });
    return () => {
      alive = false;
    };
  }, [project.id, project.path, refresh, storageKey, endpoint, initialFile]);

  useEffect(() => {
    let alive = true;
    let receivedDraft = false;
    const applyDraft = (draft) => {
      setContent(draft.content);
      setSavedContent(draft.savedContent);
      setContentError(draft.error || "");
      setSaving(pendingSaves.has(documentKey));
    };
    const changed = (event) => {
      if (event.detail.key === documentKey) {
        receivedDraft = true;
        applyDraft(event.detail.draft);
      }
    };
    window.addEventListener(draftEvent, changed);
    setContent(null);
    setSavedContent(null);
    setContentError("");
    setSaving(pendingSaves.has(documentKey));
    if (selected) {
      localStorage.setItem(storageKey, selected);
      setExpanded((current) => {
        const next = new Set(current);
        const parts = selected.split("/");
        parts
          .slice(0, -1)
          .forEach((_, index) => next.add(parts.slice(0, index + 1).join("/")));
        return next;
      });
      const draft = readDraft(documentKey);
      if (
        draft &&
        (draft.content !== draft.savedContent ||
          draft.error ||
          pendingSaves.has(documentKey))
      ) {
        applyDraft(draft);
      } else
        api(
          `${endpoint}${runId ? "&" : "?"}path=${encodeURIComponent(selected)}`,
        )
          .then((result) => {
            if (!alive) return;
            // Another editor may have loaded, edited or saved this document
            // since this GET began. Re-read before publishing its old result.
            const latest = readDraft(documentKey);
            if (
              latest &&
              (receivedDraft ||
                latest.generation !== draft?.generation ||
                latest.content !== latest.savedContent ||
                latest.error ||
                pendingSaves.has(documentKey))
            ) {
              applyDraft(latest);
            } else {
              writeDraft(documentKey, {
                content: result.content,
                savedContent: result.content,
                version: result.version,
                generation: crypto.randomUUID(),
              });
            }
          })
          .catch((error) => {
            if (alive && !receivedDraft) setContentError(error.message);
          });
    }
    return () => {
      alive = false;
      window.removeEventListener(draftEvent, changed);
    };
  }, [project.id, refresh, selected, storageKey, endpoint, runId, documentKey]);

  useEffect(() => {
    const warn = (event) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const tree = useMemo(() => buildFileTree(files?.files || []), [files]);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? (files?.files || []).filter((path) =>
          path.toLowerCase().includes(needle),
        )
      : [];
  }, [files, query]);
  const toggle = (path) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const selectFile = (path) => {
    setSelected(path);
  };
  const refreshFiles = () => {
    if (
      saving ||
      creating ||
      (dirty &&
        !window.confirm("Discard your unsaved changes and reload this file?"))
    )
      return;
    const draft = readDraft(documentKey);
    if (draft)
      writeDraft(documentKey, {
        ...draft,
        content: draft.savedContent,
        error: "",
      });
    setRefresh((value) => value + 1);
  };
  const beginCreate = (kind) => {
    setCreateKind(kind);
    setNewPath("");
    setListError("");
  };
  const createEntry = async (event) => {
    event.preventDefault();
    if (creating || saving) return;
    setCreating(true);
    setListError("");
    try {
      const path = newPath.trim().replaceAll("\\", "/");
      await api(endpoint, "PUT", {
        path,
        kind: createKind,
        content: "",
        baseVersion: null,
      });
      setCreateKind("");
      setNewPath("");
      setQuery("");
      if (createKind === "file") setSelected(path);
      else setExpanded((current) => new Set([...current, path]));
      setRefresh((value) => value + 1);
    } catch (error) {
      setListError(error.message);
    } finally {
      setCreating(false);
    }
  };
  const saveFile = async () => {
    if (
      !selected ||
      content === null ||
      !dirty ||
      saving ||
      creating ||
      pendingSaves.has(documentKey)
    )
      return;
    const submitted = readDraft(documentKey);
    if (!submitted) return;
    pendingSaves.set(documentKey, submitted);
    writeDraft(documentKey, { ...submitted, error: "" });
    let completed;
    try {
      const result = await api(endpoint, "PUT", {
        path: selected,
        kind: "file",
        content: submitted.content,
        baseVersion: submitted.version,
      });
      const latest = readDraft(documentKey);
      if (latest?.generation === submitted.generation) {
        completed = {
          ...latest,
          content:
            latest.content === submitted.content
              ? result.content
              : latest.content,
          savedContent: result.content,
          version: result.version,
          error: "",
        };
      }
    } catch (error) {
      const latest = readDraft(documentKey);
      if (latest?.generation === submitted.generation)
        completed = { ...latest, error: error.message };
    } finally {
      pendingSaves.delete(documentKey);
      if (completed) writeDraft(documentKey, completed);
    }
  };

  return (
    <section className="code-workspace" aria-label="Code explorer">
      <aside className="code-sidebar" aria-label="Project files">
        <div className="code-sidebar-heading">
          <span>EXPLORER</span>
          <button
            className="icon-button"
            aria-label="New file"
            title="New file"
            onClick={() => beginCreate("file")}
          >
            <Plus size={14} />
          </button>
          <button
            className="icon-button"
            aria-label="New folder"
            title="New folder"
            onClick={() => beginCreate("folder")}
          >
            <FolderPlus size={14} />
          </button>
          <button
            className="icon-button"
            aria-label="Refresh project files"
            title="Refresh project files"
            disabled={saving || creating}
            onClick={refreshFiles}
          >
            <RefreshCw size={14} />
          </button>
        </div>
        <div className="code-project-name" title={project.path}>
          <ChevronDown size={13} aria-hidden="true" />
          <strong>{project.name}</strong>
        </div>
        {createKind && (
          <form className="code-create-entry" onSubmit={createEntry}>
            {createKind === "folder" ? (
              <FolderPlus size={14} aria-hidden="true" />
            ) : (
              <FileCode2 size={14} aria-hidden="true" />
            )}
            <input
              autoFocus
              aria-label={`New ${createKind} path`}
              placeholder={
                createKind === "folder" ? "src/components" : "src/new-file.js"
              }
              value={newPath}
              onChange={(event) => setNewPath(event.target.value)}
              disabled={saving || creating}
            />
            <button
              disabled={saving || creating || !newPath.trim()}
              type="submit"
            >
              Add
            </button>
            <button
              type="button"
              aria-label="Cancel new entry"
              onClick={() => setCreateKind("")}
            >
              <X size={13} />
            </button>
          </form>
        )}
        <label className="code-file-search">
          <Search size={13} aria-hidden="true" />
          <input
            aria-label="Find a project file"
            placeholder="Find a file…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="code-tree-scroll">
          {listError && <p role="alert">{listError}</p>}
          {!files && !listError && <p>Loading project files…</p>}
          {files && !files.files.length && <p>No files in this project.</p>}
          {query.trim() ? (
            <ul className="code-search-results">
              {matches.map((path) => (
                <li key={path}>
                  <button
                    className={`code-tree-row code-file-row ${selected === path ? "selected" : ""}`}
                    aria-label={`Open ${path}`}
                    onClick={() => selectFile(path)}
                  >
                    <FileIcon path={path} />
                    <span>{path}</span>
                  </button>
                </li>
              ))}
              {files && !matches.length && (
                <li className="code-no-match">No matching files.</li>
              )}
            </ul>
          ) : (
            <ul className="code-tree">
              {tree.map((node) => (
                <TreeNode
                  key={node.path}
                  node={node}
                  depth={0}
                  expanded={expanded}
                  selected={selected}
                  onToggle={toggle}
                  onSelect={selectFile}
                />
              ))}
            </ul>
          )}
        </div>
        {files?.truncated && (
          <p className="code-truncated">Showing the first 1,500 files.</p>
        )}
      </aside>
      <main className="code-preview-pane">
        {selected ? (
          <>
            <header className="code-preview-header">
              <FileIcon path={selected} size={15} />
              <span title={selected}>{selected}</span>
              <small>{dirty ? "UNSAVED" : "SAVED"}</small>
              <button
                className="code-save-button"
                disabled={!dirty || saving || creating}
                onClick={saveFile}
              >
                <Save size={13} />
                {saving ? "Saving…" : "Save"}
              </button>
            </header>
            <div className="code-preview-scroll">
              {contentError && (
                <p className="code-preview-status" role="alert">
                  {contentError}
                </p>
              )}
              {content === null ? (
                !contentError && (
                  <p className="code-preview-status">Loading file…</p>
                )
              ) : (
                <textarea
                  ref={editorRef}
                  className="code-editor"
                  aria-label={`Edit ${selected}`}
                  value={content}
                  spellCheck="false"
                  onChange={(event) =>
                    writeDraft(documentKey, {
                      ...readDraft(documentKey),
                      content: event.target.value,
                    })
                  }
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === "s") {
                      event.preventDefault();
                      saveFile();
                    }
                  }}
                />
              )}
            </div>
          </>
        ) : (
          <div className="code-empty">
            <FileCode2 size={38} aria-hidden="true" />
            <h1>Explore {project.name}</h1>
            <p>Select a file from the explorer to view its contents.</p>
            <code>{project.path}</code>
          </div>
        )}
      </main>
    </section>
  );
}

export function ProjectCodeExplorer({ project, runs = [], selectedRunId }) {
  const sessions = runs.filter(
    (run) =>
      run.projectId === project.id &&
      !run.deletedAt &&
      run.worktree &&
      run.worktree !== project.path &&
      run.workspaceKind !== "main",
  );
  const storageKey = `fleet.code-workspace.${project.id}`;
  const [scope, setScope] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      if (
        saved?.sessionId === selectedRunId &&
        (!saved.scope || sessions.some((run) => run.id === saved.scope))
      )
        return saved.scope || "";
    } catch {}
    return sessions.some((run) => run.id === selectedRunId)
      ? selectedRunId
      : "";
  });
  const session = sessions.find((run) => run.id === scope);
  const unavailable = Boolean(scope && !session);
  useEffect(() => {
    localStorage.setItem(
      storageKey,
      JSON.stringify({ scope, sessionId: selectedRunId }),
    );
  }, [scope, selectedRunId, storageKey]);
  const changeScope = (event) => {
    setScope(event.target.value);
  };
  const folder = session?.worktree || project.path;
  return (
    <section className="project-code-workspace" aria-label="Project code">
      <header className="code-workspace-selector">
        <label>
          Working folder
          <select
            aria-label="Code working folder"
            value={scope}
            onChange={changeScope}
          >
            <option value="">
              Main project · {project.branch || project.name}
            </option>
            {sessions.map((run) => (
              <option value={run.id} key={run.id}>
                {run.title} · {run.branch || "worktree"}
              </option>
            ))}
            {unavailable && <option value={scope}>Worktree unavailable</option>}
          </select>
        </label>
        <span
          className="code-workspace-location"
          title={
            unavailable
              ? "The selected session is no longer available."
              : folder
          }
        >
          {unavailable ? "Choose another working folder" : folder}
        </span>
        <span className="code-workspace-badge">
          {scope ? "SESSION WORKTREE" : "MAIN PROJECT"}
        </span>
      </header>
      {unavailable ? (
        <p className="code-preview-status" role="alert">
          This session worktree is no longer available. Select the main project
          or another session.
        </p>
      ) : (
        <CodeExplorer
          key={scope || project.id}
          project={{ ...project, path: folder }}
          runId={scope || undefined}
        />
      )}
    </section>
  );
}
