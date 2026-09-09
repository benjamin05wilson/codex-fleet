import { useCallback, useEffect, useRef, useState } from "react";

// Fleet's own small, bounded force simulation. No continuously running timer:
// each interaction reheats it, and a settled/hidden graph stops scheduling frames.
export function createMotion(graph, layout, previous, replay = false) {
  const old = new Map((replay ? [] : previous || []).map((n) => [n.id, n]));
  const nodes = layout.map((n, i) => {
    const existing = !replay && old.get(n.id);
    if (existing)
      return { id: n.id, x: existing.x, y: existing.y, vx: 0, vy: 0 };
    const neighbours = graph.edges
      .flatMap((e) =>
        e.source === n.id
          ? [old.get(e.target)]
          : e.target === n.id
            ? [old.get(e.source)]
            : [],
      )
      .filter(Boolean);
    const angle = i * 2.399963;
    const x = neighbours.length
      ? neighbours.reduce((v, p) => v + p.x, 0) / neighbours.length
      : 500 + (n.x - 500) * 0.6;
    const y = neighbours.length
      ? neighbours.reduce((v, p) => v + p.y, 0) / neighbours.length
      : 350 + (n.y - 350) * 0.6;
    return {
      id: n.id,
      x: x + Math.cos(angle) * 8,
      y: y + Math.sin(angle) * 8,
      vx: 0,
      vy: 0,
    };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return {
    nodes,
    byId,
    edges: graph.edges
      .map((e) => [byId.get(e.source), byId.get(e.target)])
      .filter(([a, b]) => a && b),
    alpha: 1,
    ticks: 0,
    pin: null,
  };
}

export function tickMotion(model, forces) {
  const { nodes, pin } = model;
  const force = nodes.map(() => ({ x: 0, y: 0 }));
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) {
      let dx = nodes[i].x - nodes[j].x,
        dy = nodes[i].y - nodes[j].y;
      if (Math.abs(dx) + Math.abs(dy) < 0.001) {
        dx = 0.1;
        dy = 0.1;
      }
      const distance = Math.max(8, Math.hypot(dx, dy));
      const strength = Math.min(
        12,
        (6500 * forces.repel) / (distance * distance),
      );
      force[i].x += (dx / distance) * strength;
      force[i].y += (dy / distance) * strength;
      force[j].x -= (dx / distance) * strength;
      force[j].y -= (dy / distance) * strength;
    }
  for (const [a, b] of model.edges) {
    const dx = b.x - a.x,
      dy = b.y - a.y,
      distance = Math.max(1, Math.hypot(dx, dy));
    const pull = (distance - forces.distance) * 0.018 * forces.link;
    force[index.get(a.id)].x += (dx / distance) * pull;
    force[index.get(a.id)].y += (dy / distance) * pull;
    force[index.get(b.id)].x -= (dx / distance) * pull;
    force[index.get(b.id)].y -= (dy / distance) * pull;
  }
  nodes.forEach((n, i) => {
    if (n.id === pin?.id) {
      n.x = pin.x;
      n.y = pin.y;
      n.vx = 0;
      n.vy = 0;
      return;
    }
    n.vx =
      (n.vx +
        (force[i].x + (500 - n.x) * 0.001 * forces.center) * model.alpha) *
      0.72;
    n.vy =
      (n.vy +
        (force[i].y + (350 - n.y) * 0.001 * forces.center) * model.alpha) *
      0.72;
    n.x += Math.max(-8, Math.min(8, n.vx));
    n.y += Math.max(-8, Math.min(8, n.vy));
  });
  model.ticks++;
  model.alpha *= 0.984;
  return model.ticks < 300 && model.alpha > 0.012;
}

export function useGraphMotion(graph, layout, forces, onFrame) {
  const [reduced, setReduced] = useState(
    () =>
      typeof window.matchMedia !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [points, setPoints] = useState(
    () =>
      new Map(
        (reduced ? layout : createMotion(graph, layout).nodes).map((n) => [
          n.id,
          { x: n.x, y: n.y },
        ]),
      ),
  );
  const [running, setRunningState] = useState(false);
  const runningRef = useRef(false);
  const setRunning = useCallback((value) => {
    if (runningRef.current === value) return;
    runningRef.current = value;
    setRunningState(value);
  }, []);
  const livePoints = useRef(points);
  const frameCallback = useRef(onFrame);
  frameCallback.current = onFrame;
  const [replayCount, setReplayCount] = useState(0);
  const [paused, setPaused] = useState(false);
  const model = useRef(null),
    wake = useRef(() => {}),
    publish = useRef(() => {}),
    lastReplay = useRef(0);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    const replay = replayCount !== lastReplay.current;
    lastReplay.current = replayCount;
    const sim = createMotion(graph, layout, model.current?.nodes, replay);
    if (reduced)
      sim.nodes.forEach((n, i) =>
        Object.assign(n, { x: layout[i].x, y: layout[i].y }),
      );
    model.current = sim;
    let frame = null,
      disposed = false,
      lastTime = null,
      elapsed = 0,
      active = !reduced && !paused && sim.nodes.length > 1;
    const draw = () => {
      const next = new Map(sim.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
      livePoints.current = next;
      // SVG consumers paint coordinates directly; controls/labels stay in React.
      // Other consumers retain the state-based interface.
      if (frameCallback.current) frameCallback.current(next);
      else setPoints(next);
    };
    publish.current = draw;
    draw();
    const schedule = () => {
      if (disposed || !active || document.hidden || frame !== null) return;
      setRunning(true);
      frame = requestAnimationFrame(animate);
    };
    const animate = (time) => {
      frame = null;
      if (disposed || document.hidden || !active) return;
      elapsed += lastTime === null ? 17 : Math.min(34, time - lastTime);
      lastTime = time;
      while (elapsed >= 1000 / 60 && active) {
        active = tickMotion(sim, forces);
        elapsed -= 1000 / 60;
      }
      draw();
      if (active) schedule();
      else setRunning(false);
    };
    wake.current = () => {
      if (reduced || paused || disposed || sim.nodes.length < 2) return;
      sim.alpha = 1;
      sim.ticks = 0;
      active = true;
      lastTime = null;
      schedule();
    };
    const visibility = () => {
      if (document.hidden) {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        lastTime = null;
        elapsed = 0;
        setRunning(false);
      } else schedule();
    };
    document.addEventListener("visibilitychange", visibility);
    setRunning(false);
    schedule();
    return () => {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", visibility);
      wake.current = () => {};
      publish.current = () => {};
    };
  }, [graph, layout, forces, reduced, replayCount, paused]);
  return {
    points: onFrame ? livePoints.current : points,
    currentPoints: () => livePoints.current,
    running,
    reduced,
    replay: () => {
      setPaused(false);
      setReplayCount((n) => n + 1);
    },
    stop: () => setPaused(true),
    drag: (id, point) => {
      const sim = model.current,
        node = sim?.byId.get(id);
      if (!node) return;
      sim.pin = { id, ...point };
      Object.assign(node, point, { vx: 0, vy: 0 });
      publish.current();
      wake.current();
    },
    release: () => {
      if (model.current?.pin) {
        model.current.pin = null;
        wake.current();
      }
    },
  };
}
