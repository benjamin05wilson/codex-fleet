import { useEffect, useMemo, useState } from "react";
import { layoutNotes } from "./brain-layout.js";
const empty = [];

// Only send topology to the worker: note bodies can be many megabytes.
export function graphTopology(graph) {
  return {
    nodes: graph.nodes.map(({ id, title, degree }) => ({ id, title, degree })),
    edges: graph.edges,
  };
}

export function useNoteLayout(graph, forces) {
  const topologyKey = useMemo(
    () => JSON.stringify(graphTopology(graph)),
    [graph],
  );
  const topology = useMemo(() => JSON.parse(topologyKey), [topologyKey]);
  const asynchronous =
    topology.nodes.length > 80 && typeof Worker !== "undefined";
  const [result, setResult] = useState(null);
  const immediate = useMemo(
    () => (asynchronous ? null : layoutNotes(topology, forces)),
    [topology, forces, asynchronous],
  );
  const [error, setError] = useState("");
  useEffect(() => {
    if (!asynchronous) return;
    setError("");
    let worker,
      alive = true;
    try {
      worker = new Worker(
        new URL("./brain-layout.worker.js", import.meta.url),
        { type: "module" },
      );
      worker.onmessage = ({ data }) => {
        if (!alive) return;
        setResult({ topology, forces, points: data });
        worker.terminate();
      };
      worker.onerror = () => {
        if (!alive) return;
        setError("Could not arrange the graph. Reopen the brain to retry.");
        worker.terminate();
      };
      worker.postMessage({ graph: topology, forces });
    } catch {
      setError("Could not arrange the graph. Reopen the brain to retry.");
      worker?.terminate();
    }
    return () => {
      alive = false;
      worker?.terminate();
    };
  }, [topology, forces, asynchronous]);
  const ready =
    !asynchronous ||
    (result?.topology === topology && result?.forces === forces);
  const coordinates = immediate || (ready ? result?.points : null);
  const positions = useMemo(() => {
    if (!coordinates) return [];
    const byId = new Map(coordinates.map((n) => [n.id, n]));
    return graph.nodes.map((n) => ({
      ...n,
      x: byId.get(n.id).x,
      y: byId.get(n.id).y,
    }));
  }, [coordinates, graph]);
  return {
    positions,
    motionGraph: topology,
    motionLayout: coordinates || empty,
    pending: !ready && !error,
    error,
  };
}
