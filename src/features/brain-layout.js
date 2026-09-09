export const defaultForces = { center: 1, repel: 1, link: 1, distance: 190 };

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
