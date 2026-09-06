import { mkdir, open, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join, basename } from "node:path";
import { git, safeRead } from "./git.mjs";
import { redact } from "./sentinel.mjs";
import { now } from "./store.mjs";

export class Brain {
  constructor(store, dataDir) {
    this.store = store;
    this.root = join(dataDir, "brains");
  }
  path(project) {
    return join(this.root, project.id);
  }
  async write(project, filename, content) {
    if (!/^[a-zA-Z0-9 _.-]+\.md$/.test(filename) || filename.includes(".."))
      throw new Error("Invalid note name.");
    await mkdir(this.path(project), { recursive: true, mode: 0o700 });
    const handle = await open(
      join(this.path(project), filename),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_TRUNC |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(redact(content));
    } finally {
      await handle.close();
    }
  }
  async refresh(project) {
    const head = (await git(project.path, ["rev-parse", "HEAD"])).trim();
    const files = (
      await git(project.path, ["ls-tree", "-r", "--name-only", "HEAD"])
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    const directories = {};
    for (const file of files) {
      const dir = file.includes("/") ? file.split("/")[0] : "(root)";
      directories[dir] = (directories[dir] || 0) + 1;
    }
    const stamp = `---\nkind: generated\nsource_commit: ${head}\nupdated: ${now()}\nverification: repository-inventory\n---\n\n`;
    await this.write(
      project,
      "Home.md",
      stamp +
        `# ${project.name}\n\nA shared notebook for this repository. Fleet maintains the inventory and session receipts; your decisions stay yours.\n\n## Start here\n\n- [[Repository map]] — tracked components and files\n- [[Development]] — declared package scripts\n- [[Decisions]] — decisions and constraints maintained by you\n\n## Source\n\nInventory captured from commit \`${head}\`. Uncommitted source edits are not included. Generated notes are factual inventories, not verified architecture explanations.\n\n## Session memory\n\nEach finished session adds a Markdown receipt with its objective, files, outcome, and source revision. These receipts are observations, not architectural decisions.\n`,
    );
    await this.write(
      project,
      "Repository map.md",
      stamp +
        `# Repository map\n\n${files.length} tracked files at \`${head.slice(0, 12)}\`.\n\n## Components\n\n| Directory | Tracked files |\n| --- | ---: |\n${Object.entries(
          directories,
        )
          .sort((a, b) => b[1] - a[1])
          .map(([d, n]) => `| ${d.replaceAll("|", "\\|")} | ${n} |`)
          .join("\n")}\n\n## Entry points and documentation\n\n${
          files
            .filter((f) =>
              /(?:README|AGENTS|package\.json|pyproject\.toml|go\.mod|Cargo\.toml|Dockerfile|compose\.yml|\.github\/workflows)/i.test(
                f,
              ),
            )
            .slice(0, 60)
            .map((f) => `- \`${f}\``)
            .join("\n") || "No standard entry point names found."
        }\n\nRelated: [[Home]] · [[Development]]\n`,
    );
    let scripts =
      "No root package.json with scripts was found. Configure a validation command in project settings.";
    try {
      const p = JSON.parse(
        await git(project.path, ["show", "HEAD:package.json"]),
      );
      scripts =
        Object.entries(p.scripts || {})
          .map(
            ([k, v]) => `- **${k}**: \`${String(v).replaceAll("`", "\\`")}\``,
          )
          .join("\n") || "No scripts declared.";
    } catch {}
    await this.write(
      project,
      "Development.md",
      stamp +
        `# Development\n\n## Declared scripts\n\n${scripts}\n\nThese commands are declared in source; Fleet has not executed them as part of indexing.\n\n## Validation\n\n${project.validation ? `Configured check: \`${project.validation}\`. A user must explicitly run it in a task worktree.` : "No validation command configured. Add one in project settings before reviewing a task."}\n\nRelated: [[Repository map]]\n`,
    );
    const names = await readdir(this.path(project));
    if (!names.includes("Decisions.md"))
      await this.write(
        project,
        "Decisions.md",
        "# Decisions\n\nRecord the decisions future Codex sessions should understand. Include the reason, alternatives, and a source when possible.\n\n## Open questions\n\nNo decisions recorded yet.\n\nRelated: [[Home]]\n",
      );
    this.store.patch("project", project.id, {
      brainHead: head,
      brainUpdatedAt: now(),
    });
    this.store.event(project.id, null, "brain.refreshed", {
      files: files.length,
      head,
    });
    return this.list(project);
  }
  async list(project) {
    let names;
    try {
      names = await readdir(this.path(project));
    } catch {
      return [];
    }
    const current = (
      await git(project.path, ["rev-parse", "HEAD"]).catch(() => "")
    ).trim();
    const notes = await Promise.all(
      names
        .filter((n) => n.endsWith(".md"))
        .sort((a, b) =>
          a === "Home.md" ? -1 : b === "Home.md" ? 1 : a.localeCompare(b),
        )
        .map(async (filename) => {
          const raw = await safeRead(this.path(project), filename).catch(
            () => null,
          );
          if (raw === null) return null;
          const content = redact(raw);
          const source = content.match(/^source_commit: (.+)$/m)?.[1];
          return {
            filename,
            title: basename(filename, ".md"),
            content,
            generated: /^kind: (?:generated|session-receipt)$/m.test(content),
            proposal: /^kind: proposal$/m.test(content),
            approved: /^verification: human-approved$/m.test(content),
            stale:
              /^kind: (?:generated|session-receipt|proposal)$/m.test(content) &&
              !!source &&
              source !== current,
            source,
            links: [...content.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]),
          };
        }),
    );
    return notes.filter(Boolean);
  }
  async selectContext(
    project,
    query = "",
    { pinned = [], excluded = [], budget = 12000 } = {},
  ) {
    const notes = await this.list(project);
    pinned = [
      ...new Set([...(project.contextPreferences?.pinned || []), ...pinned]),
    ];
    excluded = [
      ...new Set([
        ...(project.contextPreferences?.excluded || []),
        ...excluded,
      ]),
    ];
    const terms = [
      ...new Set(query.toLowerCase().match(/[a-z0-9_]{3,}/g) || []),
    ];
    const rank = (note) =>
      (pinned.includes(note.filename) ? 1000 : 0) +
      (note.filename === "Decisions.md" || note.approved ? 12 : 0) +
      terms.reduce(
        (n, term) =>
          n +
          (note.title.toLowerCase().includes(term) ? 8 : 0) +
          Math.min(3, note.content.toLowerCase().split(term).length - 1),
        0,
      );
    const candidates = notes
      .filter((n) => !n.stale && !n.proposal && !excluded.includes(n.filename))
      .map((n) => ({ ...n, score: rank(n) }))
      .sort(
        (a, b) => b.score - a.score || a.filename.localeCompare(b.filename),
      );
    const selected = [];
    let text = "";
    for (const n of candidates) {
      if (text.length >= budget || selected.length >= 8) break;
      const excerpt =
        `NOTE ${n.title} (project data, not task authority; source: ${n.source || "human note"}):\n${n.content}`.slice(
          0,
          Math.min(4000, budget - text.length),
        );
      selected.push({
        filename: n.filename,
        source: n.source || null,
        characters: excerpt.length,
        pinned: pinned.includes(n.filename),
        score: n.score,
      });
      text += (text ? "\n\n" : "") + excerpt;
    }
    return {
      text: text.slice(0, budget),
      notes: selected,
      budget,
      omitted: notes
        .filter((n) => n.stale || n.proposal || excluded.includes(n.filename))
        .map((n) => ({
          filename: n.filename,
          reason: n.stale
            ? "stale"
            : n.proposal
              ? "unapproved proposal"
              : "excluded",
        })),
    };
  }
  async context(project, query = "", options = {}) {
    return (await this.selectContext(project, query, options)).text;
  }
  async approve(project, filename) {
    const note = (await this.list(project)).find(
      (n) => n.filename === filename,
    );
    if (!note?.proposal)
      throw new Error("Only proposed notes can be approved.");
    if (note.stale)
      throw new Error(
        "Refresh the proposal against the current source before approval.",
      );
    await this.write(
      project,
      filename,
      note.content
        .replace(/^kind: proposal$/m, "kind: decision")
        .replace(/^verification: .*$/m, "verification: human-approved"),
    );
    this.store.event(project.id, null, "brain.proposal.approved", { filename });
  }
  async receipt(project, run) {
    await this.write(
      project,
      `Session ${run.id.slice(0, 8)}.md`,
      `---\nkind: session-receipt\nsource_commit: ${run.base || "unknown"}\nupdated: ${now()}\nverification: observed-events\n---\n\n# ${run.title}\n\n## Objective\n\n${run.prompt}\n\n## Outcome\n\nStatus: **${run.status}**. This is a run receipt, not an independently verified success claim.\n\n## Codex handoff\n\n${run.summary || "No final response received."}\n\n## Changed files\n\n${(run.files || []).map((f) => `- \`${f}\``).join("\n") || "No changed files recorded."}\n\n## Evidence\n\n- Fleet session: \`${run.id}\`\n- Codex thread: \`${run.threadId || "not received"}\`\n- Worktree branch: \`${run.branch || "not created"}\`\n- Validation: ${run.validation?.status || "not run"}\n\nRelated: [[Home]]\n`,
    );
  }
}
