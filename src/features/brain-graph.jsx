import React, { useEffect, useMemo, useRef, useState } from "react";
import { useGraphMotion } from "./brain-motion.js";
import {
  Focus,
  Minus,
  Plus,
  Search,
  Settings2,
  RotateCcw,
  X,
  ChevronRight,
} from "lucide-react";

export const noteTarget = (link) =>
  String(link).split("|")[0].split("#")[0].trim().replace(/\.md$/i, "");
export const noteKind = (note) =>
  note.proposal
    ? "proposal"
    : /^kind: session-receipt$/m.test(note.content || "")
      ? "session"
      : note.generated
        ? "generated"
        : "human";

export function buildNoteGraph(notes) {
  const nodes = notes.slice(0, 250).map((note) => ({
    ...note,
    id: note.filename,
    kind: noteKind(note),
    degree: 0,
  }));
  const lookup = new Map(
    nodes.flatMap((n) => [
      [n.title.toLowerCase(), n],
      [noteTarget(n.filename).toLowerCase(), n],
    ]),
  );
  const seen = new Set(),
    edges = [];
  for (const node of nodes)
    for (const link of node.links || []) {
      const target = lookup.get(noteTarget(link).toLowerCase());
      if (!target || target.id === node.id) continue;
      const key = [node.id, target.id].sort().join("\0");
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: node.id, target: target.id });
      node.degree++;
      target.degree++;
    }
  return { nodes, edges, omitted: Math.max(0, notes.length - nodes.length) };
}

const defaultForces = { center: 1, repel: 1, link: 1, distance: 190 };
const defaultDisplay = { nodeSize: 1, linkWidth: 1, fade: 0 };

export function layoutNotes(graph, forces = defaultForces) {
  if (!graph.nodes.length) return [];
  // Deterministic starting positions; every node is free to settle. There is
  // no special root in a note graph, including the vault's Home note.
  const hub = [...graph.nodes].sort(
    (a, b) =>
      b.degree - a.degree ||
      (a.id === "Home.md"
        ? -1
        : b.id === "Home.md"
          ? 1
          : a.id.localeCompare(b.id)),
  )[0];
  const others = graph.nodes.filter((n) => n.id !== hub.id);
  const nodes = graph.nodes.map((n) => {
    const i = others.findIndex((p) => p.id === n.id);
    const angle = -Math.PI / 2 + (i * Math.PI * 2) / Math.max(1, others.length);
    const radius = 210 + Math.floor(i / 12) * 80;
    return {
      ...n,
      x: n.id === hub.id ? 500 : 500 + Math.cos(angle) * radius,
      y: n.id === hub.id ? 350 : 350 + Math.sin(angle) * radius,
    };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  for (let step = 0; step < 220; step++) {
    const force = nodes.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].x - nodes[j].x,
          dy = nodes[i].y - nodes[j].y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const labelSpace = Math.min(
          180,
          65 + Math.max(nodes[i].title.length, nodes[j].title.length) * 4,
        );
        const collision =
          Math.abs(dy) < 55 ? Math.max(0, labelSpace - Math.abs(dx)) * 0.06 : 0;
        const strength = (6500 * forces.repel) / (d * d) + collision;
        force[i].x += (dx / d) * strength;
        force[i].y += (dy / d) * strength;
        force[j].x -= (dx / d) * strength;
        force[j].y -= (dy / d) * strength;
      }
    for (const edge of graph.edges) {
      const a = byId.get(edge.source),
        b = byId.get(edge.target);
      const dx = b.x - a.x,
        dy = b.y - a.y,
        d = Math.max(1, Math.hypot(dx, dy));
      const pull = (d - forces.distance) * 0.018 * forces.link;
      force[index.get(a.id)].x += (dx / d) * pull;
      force[index.get(a.id)].y += (dy / d) * pull;
      force[index.get(b.id)].x -= (dx / d) * pull;
      force[index.get(b.id)].y -= (dy / d) * pull;
    }
    nodes.forEach((n, i) => {
      n.x += Math.max(
        -7,
        Math.min(7, force[i].x + (500 - n.x) * 0.001 * forces.center),
      );
      n.y += Math.max(
        -7,
        Math.min(7, force[i].y + (350 - n.y) * 0.001 * forces.center),
      );
    });
  }
  return nodes;
}

export function fitNoteGraph(points, width = 1000, height = 700) {
  if (!points.length) return { x: 0, y: 0, zoom: 1 };
  const minX = Math.min(...points.map((n) => n.x)),
    maxX = Math.max(...points.map((n) => n.x));
  const minY = Math.min(...points.map((n) => n.y)),
    maxY = Math.max(...points.map((n) => n.y));
  const zoom = Math.min(
    1.5,
    Math.max(100, width - 210) / Math.max(380, maxX - minX + 170),
    Math.max(100, height - 240) / Math.max(300, maxY - minY + 90),
  );
  return {
    x: (-(minX + maxX - 1000) / 2) * zoom,
    y: (-(minY + maxY - 700) / 2) * zoom - 10,
    zoom,
  };
}

export function initialNoteGraph(points, width = 1000, height = 700) {
  if (!points.length) return { x: 0, y: 0, zoom: 1 };
  const minX = Math.min(...points.map((n) => n.x)),
    maxX = Math.max(...points.map((n) => n.x));
  const minY = Math.min(...points.map((n) => n.y)),
    maxY = Math.max(...points.map((n) => n.y));
  const zoom = Math.min(
    2.4,
    Math.max(100, width - 100) / Math.max(240, maxX - minX + 80),
    Math.max(100, height - 100) / Math.max(240, maxY - minY + 60),
  );
  return {
    x: (-(minX + maxX - 1000) / 2) * zoom,
    y: (-(minY + maxY - 700) / 2) * zoom,
    zoom,
  };
}

const labels = {
  human: "Your notes",
  generated: "Inventory",
  session: "Sessions",
  proposal: "Proposals",
};
export function BrainGraph({ notes, selected, onSelect, query, onQuery }) {
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [forces, setForces] = useState(defaultForces);
  const [display, setDisplay] = useState(defaultDisplay);
  const [groups, setGroups] = useState(false);
  const [orphans, setOrphans] = useState(true);
  const graph = useMemo(() => buildNoteGraph(notes), [notes]);
  const positions = useMemo(() => layoutNotes(graph, forces), [graph, forces]);
  const [camera, setCamera] = useState(() => initialNoteGraph(positions));
  const [local, setLocal] = useState(false),
    [kind, setKind] = useState("all"),
    [hover, setHover] = useState(null);
  const motion = useGraphMotion(graph, positions, forces);
  const gesture = useRef(null),
    svg = useRef(null);
  const [viewport, setViewport] = useState({ width: 1000, height: 700 });
  const initialViewportMeasured = useRef(false);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        setViewport({ width, height });
        if (!initialViewportMeasured.current) {
          initialViewportMeasured.current = true;
          setCamera(initialNoteGraph(positions, width, height));
        }
      }
    });
    observer.observe(svg.current);
    return () => observer.disconnect();
  }, []);
  const connected = (id) =>
    new Set([
      id,
      ...graph.edges.flatMap((e) =>
        e.source === id ? [e.target] : e.target === id ? [e.source] : [],
      ),
    ]);
  const nearby = connected(selected),
    highlighted = connected(hover);
  const visible = positions.filter(
    (n) =>
      (!local || nearby.has(n.id)) &&
      (orphans || n.degree > 0) &&
      (kind === "all" || kind === n.kind) &&
      (!query ||
        `${n.title} ${n.content}`.toLowerCase().includes(query.toLowerCase())),
  );
  const ids = new Set(visible.map((n) => n.id));
  const byId = new Map(
    positions.map((n) => [n.id, { ...n, ...motion.points.get(n.id) }]),
  );
  const edges = graph.edges.filter(
    (e) => ids.has(e.source) && ids.has(e.target),
  );
  const zoom = (factor) =>
    setCamera((c) => ({
      ...c,
      zoom: Math.max(0.05, Math.min(3, c.zoom * factor)),
    }));
  const fit = () =>
    setCamera(
      fitNoteGraph(
        visible.map((n) => byId.get(n.id)),
        viewport.width,
        viewport.height,
      ),
    );
  const point = (e) => {
    const p = svg.current.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    return p.matrixTransform(svg.current.getScreenCTM().inverse());
  };
  return (
    <section
      className="brain-graph"
      data-animating={motion.running}
      data-hovering={!!hover}
      data-groups={groups}
      style={{
        "--graph-link-width": display.linkWidth,
        "--graph-label-opacity": Math.max(
          0,
          Math.min(1, (camera.zoom / Math.pow(2, display.fade) - 0.15) * 5),
        ),
      }}
      aria-label="Project knowledge graph"
    >
      <div className="graph-settings-anchor">
        {!settingsOpen && (
          <button
            className="graph-settings-toggle"
            aria-label="Graph settings"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen(!settingsOpen)}
          >
            <Settings2 size={18} />
          </button>
        )}
        {settingsOpen && (
          <aside
            className="brain-graph-controls"
            aria-label="Graph settings panel"
          >
            <div className="graph-settings-heading">
              <button
                aria-label="Restore default graph settings"
                onClick={() => {
                  setForces(defaultForces);
                  setDisplay(defaultDisplay);
                  setGroups(false);
                  setOrphans(true);
                  setLocal(false);
                  setKind("all");
                  onQuery("");
                  motion.replay();
                  setCamera(
                    initialNoteGraph(
                      layoutNotes(graph),
                      viewport.width,
                      viewport.height,
                    ),
                  );
                }}
              >
                <RotateCcw size={14} />
              </button>
              <button
                aria-label="Close graph settings"
                onClick={() => setSettingsOpen(false)}
              >
                <X size={16} />
              </button>
            </div>
            <details>
              <summary>
                <ChevronRight size={13} />
                Filters
              </summary>
              <div className="graph-settings-section">
                <label className="brain-graph-search">
                  <Search size={14} />
                  <input
                    aria-label="Search graph"
                    placeholder="Search files…"
                    value={query}
                    onChange={(e) => onQuery(e.target.value)}
                  />
                </label>
                <label className="graph-setting-row">
                  Note type
                  <select
                    aria-label="Note type"
                    value={kind}
                    onChange={(e) => setKind(e.target.value)}
                  >
                    <option value="all">All notes</option>
                    {Object.entries(labels).map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="graph-setting-row">
                  Orphans
                  <input
                    type="checkbox"
                    role="switch"
                    checked={orphans}
                    onChange={(e) => setOrphans(e.target.checked)}
                  />
                </label>
                <button
                  className={local ? "active" : ""}
                  aria-pressed={local}
                  onClick={() => setLocal(!local)}
                >
                  Local graph
                </button>
              </div>
            </details>
            <details>
              <summary>
                <ChevronRight size={13} />
                Groups
              </summary>
              <div className="graph-settings-section">
                <label className="graph-setting-row">
                  Color by note type
                  <input
                    type="checkbox"
                    role="switch"
                    checked={groups}
                    onChange={(e) => setGroups(e.target.checked)}
                  />
                </label>
                {groups && (
                  <div className="graph-legend">
                    {Object.entries(labels).map(([id, name]) => (
                      <span key={id}>
                        <i className={id} />
                        {name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </details>
            <details>
              <summary>
                <ChevronRight size={13} />
                Display
              </summary>
              <div className="graph-settings-section">
                {[
                  ["fade", "Text fade threshold", -3, 3],
                  ["nodeSize", "Node size", 0.1, 4],
                  ["linkWidth", "Link thickness", 0.1, 4],
                ].map(([key, name, min, max]) => (
                  <label
                    className="graph-setting-row graph-slider-row"
                    key={key}
                  >
                    <span>{name}</span>
                    <output aria-hidden="true">
                      {display[key].toFixed(2)}
                    </output>
                    <input
                      type="range"
                      aria-label={name}
                      min={min}
                      max={max}
                      step="0.1"
                      value={display[key]}
                      style={{
                        "--range-fill": `${((display[key] - min) / (max - min)) * 100}%`,
                      }}
                      onChange={(e) =>
                        setDisplay((d) => ({
                          ...d,
                          [key]: Number(e.target.value),
                        }))
                      }
                    />
                  </label>
                ))}
                <button
                  className="graph-animate"
                  disabled={motion.reduced || graph.nodes.length < 2}
                  onClick={motion.running ? motion.stop : motion.replay}
                  title={
                    motion.reduced
                      ? "Animations are disabled by your reduced-motion preference"
                      : "Replay or pause the graph's settling motion"
                  }
                >
                  {motion.running ? "Pause animation" : "Animate"}
                </button>
                {motion.reduced && (
                  <small className="graph-motion-hint">
                    Reduced motion is on.
                  </small>
                )}
              </div>
            </details>
            <details>
              <summary>
                <ChevronRight size={13} />
                Forces
              </summary>
              <div className="graph-settings-section">
                {[
                  ["center", "Center force", 0.1, 3, 0.1],
                  ["repel", "Repel force", 0.1, 3, 0.1],
                  ["link", "Link force", 0.1, 3, 0.1],
                  ["distance", "Link distance", 80, 300, 10],
                ].map(([key, name, min, max, step]) => (
                  <label
                    className="graph-setting-row graph-slider-row"
                    key={key}
                  >
                    <span>{name}</span>
                    <output aria-hidden="true">{forces[key].toFixed(2)}</output>
                    <input
                      type="range"
                      aria-label={name}
                      min={min}
                      max={max}
                      step={step}
                      value={forces[key]}
                      style={{
                        "--range-fill": `${((forces[key] - min) / (max - min)) * 100}%`,
                      }}
                      onChange={(e) => {
                        setForces((f) => ({
                          ...f,
                          [key]: Number(e.target.value),
                        }));
                      }}
                    />
                  </label>
                ))}
              </div>
            </details>
          </aside>
        )}
      </div>
      <svg
        ref={svg}
        viewBox={`0 0 ${viewport.width} ${viewport.height}`}
        aria-label="Linked notes"
        className="brain-graph-canvas"
        onWheel={(e) => zoom(e.deltaY < 0 ? 1.08 : 1 / 1.08)}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const start = point(e),
            id = e.target.closest("[data-note]")?.getAttribute("data-note");
          gesture.current = {
            start,
            id,
            camera,
            origin: id ? byId.get(id) : null,
            distance: 0,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const g = gesture.current;
          if (!g) return;
          const p = point(e),
            dx = p.x - g.start.x,
            dy = p.y - g.start.y;
          g.distance = Math.max(g.distance, Math.hypot(dx, dy));
          if (g.id && g.distance >= 3)
            motion.drag(g.id, {
              x: g.origin.x + dx / g.camera.zoom,
              y: g.origin.y + dy / g.camera.zoom,
            });
          else if (!g.id)
            setCamera({ ...g.camera, x: g.camera.x + dx, y: g.camera.y + dy });
        }}
        onPointerUp={(e) => {
          const g = gesture.current;
          gesture.current = null;
          motion.release();
          if (g?.id && g.distance < 5) onSelect(g.id);
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => {
          gesture.current = null;
          motion.release();
        }}
        onLostPointerCapture={() => {
          gesture.current = null;
          motion.release();
        }}
      >
        <g
          transform={`translate(${viewport.width / 2 + camera.x} ${viewport.height / 2 + camera.y}) scale(${camera.zoom}) translate(-500 -350)`}
        >
          {edges.map((e) => {
            const a = byId.get(e.source),
              b = byId.get(e.target);
            return (
              <line
                key={`${e.source}-${e.target}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                className={
                  e.source === hover || e.target === hover
                    ? "graph-edge active"
                    : "graph-edge"
                }
              />
            );
          })}
          {visible.map((node) => {
            const n = byId.get(node.id),
              radius =
                (4 + Math.min(8, Math.sqrt(n.degree) * 2)) * display.nodeSize;
            return (
              <g
                key={n.id}
                data-note={n.id}
                className={`graph-node ${n.kind} ${selected === n.id ? "selected" : ""} ${n.stale ? "stale" : ""} ${highlighted.has(n.id) ? "connected" : ""}`}
                transform={`translate(${n.x} ${n.y})`}
                role="button"
                tabIndex={0}
                aria-label={`Open note: ${n.title}`}
                aria-pressed={selected === n.id}
                onClick={(e) => {
                  if (e.detail === 0) onSelect(n.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(n.id);
                  }
                }}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(n.id)}
                onBlur={() => setHover(null)}
              >
                <title>
                  {n.title} · {labels[n.kind]}
                  {n.stale ? " · Older source revision" : ""}
                </title>
                <circle className="graph-hit" r={24} />
                <circle className="graph-core" r={radius} />
                <g
                  className="graph-label"
                  transform={`translate(0 ${radius + 12})`}
                >
                  <text y={4} textAnchor="middle">
                    {n.title.length > 35 ? n.title.slice(0, 32) + "…" : n.title}
                  </text>
                </g>
              </g>
            );
          })}
        </g>
      </svg>
      {!visible.length && (
        <p className="graph-empty">
          {notes.length
            ? "No notes match these filters."
            : "Your graph will grow as notes and session receipts are written."}
        </p>
      )}
      <div className="graph-camera">
        <button aria-label="Zoom out" onClick={() => zoom(1 / 1.2)}>
          <Minus size={15} />
        </button>
        <button aria-label="Fit graph" onClick={fit}>
          <Focus size={15} />
        </button>
        <button aria-label="Zoom in" onClick={() => zoom(1.2)}>
          <Plus size={15} />
        </button>
      </div>
      <div className="graph-footnote">
        {visible.length} notes · {edges.length} links
        {graph.omitted > 0
          ? ` · ${graph.omitted} more notes in Notes view`
          : ""}
      </div>
    </section>
  );
}
