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

export function CodeExplorer({
  project,
  runId,
  initialFile,
  initialLine = 1,
  onDirtyChange,
}) {
  const storageKey = `fleet.code-file.${runId || project.id}`;
  const endpoint = `/projects/${project.id}/files${runId ? `?runId=${encodeURIComponent(runId)}` : ""}`;
  const editorRef = useRef(null);
  const locationApplied = useRef(false);
  const [files, setFiles] = useState(null);
  const [selected, setSelected] = useState(
    () => initialFile || localStorage.getItem(storageKey) || "",
  );
  const [expanded, setExpanded] = useState(new Set());
  const [query, setQuery] = useState("");
  const [content, setContent] = useState(null);
  const [savedContent, setSavedContent] = useState(null);
  const [version, setVersion] = useState(null);
  const [listError, setListError] = useState("");
  const [contentError, setContentError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [saving, setSaving] = useState(false);
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
          if (
            !current ||
            current === initialFile ||
            result.files.includes(current)
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
    setContent(null);
    setSavedContent(null);
    setVersion(null);
    setContentError("");
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
      api(`${endpoint}${runId ? "&" : "?"}path=${encodeURIComponent(selected)}`)
        .then((result) => {
          if (alive) {
            setContent(result.content);
            setSavedContent(result.content);
            setVersion(result.version);
          }
        })
        .catch((error) => {
          if (alive) setContentError(error.message);
        });
    }
    return () => {
      alive = false;
    };
  }, [project.id, refresh, selected, storageKey, endpoint, runId]);

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
  const leaveCurrentFile = () =>
    !dirty || window.confirm("Discard your unsaved changes?");
  const selectFile = (path) => {
    if (path !== selected && !leaveCurrentFile()) return;
    setSelected(path);
  };
  const refreshFiles = () => {
    if (!leaveCurrentFile()) return;
    setRefresh((value) => value + 1);
  };
  const beginCreate = (kind) => {
    if (!leaveCurrentFile()) return;
    setCreateKind(kind);
    setNewPath("");
    setListError("");
  };
  const createEntry = async (event) => {
    event.preventDefault();
    setSaving(true);
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
      setSaving(false);
    }
  };
  const saveFile = async () => {
    if (!selected || content === null || !dirty || saving) return;
    setSaving(true);
    setContentError("");
    try {
      const result = await api(endpoint, "PUT", {
        path: selected,
        kind: "file",
        content,
        baseVersion: version,
      });
      setSavedContent(result.content);
      setVersion(result.version);
      setRefresh((value) => value + 1);
    } catch (error) {
      setContentError(error.message);
    } finally {
      setSaving(false);
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
              disabled={saving}
            />
            <button disabled={saving || !newPath.trim()} type="submit">
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
                disabled={!dirty || saving}
                onClick={saveFile}
              >
                <Save size={13} />
                {saving ? "Saving…" : "Save"}
              </button>
            </header>
            <div className="code-preview-scroll">
              {contentError ? (
                <p className="code-preview-status" role="alert">
                  {contentError}
                </p>
              ) : content === null ? (
                <p className="code-preview-status">Loading file…</p>
              ) : (
                <textarea
                  ref={editorRef}
                  className="code-editor"
                  aria-label={`Edit ${selected}`}
                  value={content}
                  spellCheck="false"
                  onChange={(event) => setContent(event.target.value)}
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
  const [dirty, setDirty] = useState(false);
  const session = sessions.find((run) => run.id === scope);
  const unavailable = Boolean(scope && !session);
  useEffect(() => {
    localStorage.setItem(
      storageKey,
      JSON.stringify({ scope, sessionId: selectedRunId }),
    );
  }, [scope, selectedRunId, storageKey]);
  const changeScope = (event) => {
    if (
      dirty &&
      !window.confirm(
        "Discard your unsaved changes before switching working folders?",
      )
    )
      return;
    setDirty(false);
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
          onDirtyChange={setDirty}
        />
      )}
    </section>
  );
}
