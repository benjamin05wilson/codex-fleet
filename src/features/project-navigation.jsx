import React from "react";
import { Home, LayoutGrid, Plus, X } from "lucide-react";

export function ProjectNavigation({
  projects,
  closedProjectTabs = [],
  projectId,
  view,
  allProjects,
  onHome,
  onAll,
  onProject,
  onClose,
  onNew,
  onOpen,
  busy,
}) {
  return (
    <nav className="project-navigation" aria-label="Workspace navigation">
      <div className="project-nav-pinned">
        <button
          aria-current={view === "home" ? "page" : undefined}
          onClick={onHome}
        >
          <Home size={14} />
          Home
        </button>
        <button
          aria-current={view !== "home" && allProjects ? "page" : undefined}
          onClick={onAll}
        >
          <LayoutGrid size={14} />
          All projects
        </button>
      </div>
      <div className="project-tab-strip">
        {projects
          .filter((p) => !closedProjectTabs.includes(p.id))
          .map((p) => {
            const path = p.sourcePath || p.path || "";
            const duplicate = projects.some(
              (other) => other.id !== p.id && other.name === p.name,
            );
            const label =
              duplicate && path
                ? path.split(/[\\/]/).filter(Boolean).at(-1)
                : p.name;
            return (
              <div
                className="project-tab"
                key={p.id}
                data-active={
                  view !== "home" && !allProjects && projectId === p.id
                }
              >
                <button
                  aria-label={`${p.name} — ${path || "project"}`}
                  aria-current={
                    view !== "home" && !allProjects && projectId === p.id
                      ? "page"
                      : undefined
                  }
                  title={path || p.name}
                  onClick={() => onProject(p.id)}
                >
                  <span>{label}</span>
                </button>
                <button
                  className="project-tab-close"
                  aria-label={`Close tab: ${p.name} — ${path || "project"}`}
                  title="Close tab (project and sessions are kept)"
                  onClick={() => onClose(p.id)}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
      </div>
      <details
        className="project-tab-add"
        data-empty={!projects.some((p) => !closedProjectTabs.includes(p.id))}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.currentTarget.open = false;
            e.currentTarget.querySelector("summary").focus();
          }
        }}
      >
        <summary aria-label="Open project tab" title="Open project tab">
          <Plus size={17} />
        </summary>
        <div
          className="workspace-menu"
          role="group"
          aria-label="Open a project tab"
          onClick={(e) => {
            if (e.target.closest("button:not(:disabled)"))
              e.currentTarget.closest("details").open = false;
          }}
        >
          <button onClick={onNew} disabled={busy}>
            New project…
          </button>
          <button onClick={onOpen} disabled={busy}>
            Open folder…
          </button>
          <hr />
          <div className="project-tab-choices">
            {projects
              .filter((p) => closedProjectTabs.includes(p.id))
              .map((p) => (
                <button
                  key={p.id}
                  aria-label={`Open tab: ${p.name} — ${p.sourcePath || p.path || "project"}`}
                  onClick={() => onProject(p.id)}
                >
                  <span>{p.name}</span>
                  <small>{p.sourcePath || p.path}</small>
                </button>
              ))}
            {!projects.some((p) => closedProjectTabs.includes(p.id)) && (
              <p>All project tabs are open.</p>
            )}
          </div>
        </div>
      </details>
    </nav>
  );
}
