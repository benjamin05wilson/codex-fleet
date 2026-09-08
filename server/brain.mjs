import { mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, basename } from "node:path";
import { git, safeRead } from "./git.mjs";
import { redact } from "./sentinel.mjs";
import { now } from "./store.mjs";
import {
  capture,
  compareSnapshots,
  digest,
  knowledgeNotes,
  knowledgeFingerprint,
  projectRevision,
  scopeFor,
  worktrees,
} from "./brain-index.mjs";

export class Brain {
  constructor(store, dataDir) {
    this.store = store;
    this.root = join(dataDir, "brains");
    this.closed = false;
    this.pending = null;
    this.scopeWrites = new Map();
    this.turnWrites = new Map();
    for (const job of store
      .list("brain-job")
      .filter((j) => j.status === "running"))
      store.patch("brain-job", job.id, { status: "queued", attempts: 0 });
  }
  start() {
    this.timer = setInterval(() => this.drain().catch(() => {}), 1000);
    for (const project of this.store
      .list("project")
      .filter((p) => !p.removedAt))
      this.enqueue(project, "startup");
  }
  enqueue(project, reason = "external changes") {
    if (this.closed || this.store.get("project", project.id).removedAt) return;
    const old = this.store.list("brain-job").find((j) => j.id === project.id);
    this.store.put("brain-job", {
      id: project.id,
      projectId: project.id,
      status: "queued",
      reason,
      generation: (old?.generation || 0) + 1,
      attempts: 0,
      queuedAt: now(),
    });
  }
  status(project) {
    return (
      this.store.list("brain-job").find((j) => j.id === project.id) || {
        status: "idle",
      }
    );
  }
  scopes(project) {
    return this.store
      .list("brain-scope")
      .filter((i) => i.projectId === project.id && !i.archived)
      .map(({ scope, label, root, head, snapshot, updatedAt, skipped }) => ({
        scope,
        label,
        root,
        head,
        snapshot,
        updatedAt,
        skipped,
      }));
  }
  isManaged(project, filename) {
    return this.store
      .list("brain-note")
      .some((n) => n.projectId === project.id && n.filename === filename);
  }
  async generated(project, filename, content) {
    const key = `${project.id}:${filename}`;
    const owned = this.store.list("brain-note").find((n) => n.id === key);
    const existing = await safeRead(
      this.path(project),
      filename,
      2_000_000,
    ).catch((e) => {
      if (e.code === "ENOENT") return undefined;
      throw e;
    });
    if (
      existing !== undefined &&
      (!owned || existing === null || digest(existing) !== owned.hash)
    ) {
      // Never overwrite a colliding human note or an externally edited note.
      this.store.event(project.id, null, "brain.note.preserved", { filename });
      return false;
    }
    const text = redact(content);
    if (
      owned &&
      existing &&
      knowledgeFingerprint(existing) === knowledgeFingerprint(text)
    )
      return true;
    if (existing !== text) await this.write(project, filename, text);
    this.store.put("brain-note", {
      id: key,
      projectId: project.id,
      filename,
      hash: digest(text),
    });
    return true;
  }
  async indexProject(project) {
    const revision = await projectRevision(
      this.store.get("project", project.id),
    );
    if (!this.store.get("project", project.id).brainRef)
      this.store.patch("project", project.id, { brainRef: revision.ref });
    const live = [
      {
        scope: "project",
        label: revision.ref.replace(/^refs\/heads\//, ""),
        root: project.path,
        revision: revision.head,
      },
    ];
    for (const tree of await worktrees(project)) {
      try {
        live.push({
          scope: await scopeFor(tree.path),
          label: tree.branch,
          root: tree.path,
        });
      } catch (e) {
        this.store.event(project.id, null, "brain.worktree.unavailable", {
          reason: redact(e.message),
        });
      }
    }
    for (const entry of live) {
      if (this.closed || this.store.get("project", project.id).removedAt)
        return;
      const key = `${project.id}:${entry.scope}`;
      let previous;
      try {
        previous = this.store.get("brain-index", key);
      } catch {}
      const index = await capture(entry.root, {
        revision: entry.revision,
        previous,
      });
      await this.publishIndex(project, entry, index);
    }
    for (const old of this.store
      .list("brain-scope")
      .filter(
        (i) =>
          i.projectId === project.id && !live.some((e) => e.scope === i.scope),
      ))
      this.store.patch("brain-scope", old.id, { archived: true });
    this.store.event(project.id, null, "brain.indexed", {
      scopes: live.length,
    });
  }
  async publishIndex(project, entry, index) {
    const key = `${project.id}:${entry.scope}`;
    const previousWrite = this.scopeWrites.get(key) || Promise.resolve();
    const pending = previousWrite
      .catch(() => {})
      .then(async () => {
        const previous = this.store
          .list("brain-scope")
          .find((i) => i.id === key);
        if (
          (previous?.snapshot === index.snapshot && !previous.archived) ||
          previous?.capturedAt > index.capturedAt
        )
          return;
        const notes = knowledgeNotes(index, entry.scope, entry.label);
        for (const note of notes)
          await this.generated(project, note.filename, note.content);
        const { files, ...metadata } = index;
        this.store.put("brain-index", {
          id: key,
          projectId: project.id,
          ...index,
        });
        this.store.put("brain-scope", {
          id: key,
          projectId: project.id,
          ...entry,
          ...metadata,
          notes: notes.map((n) => ({
            filename: n.filename,
            topic: n.topic,
            fingerprint: knowledgeFingerprint(redact(n.content)),
          })),
          archived: false,
          updatedAt: now(),
        });
        this.store.patch("project", project.id, { brainUpdatedAt: now() });
      });
    this.scopeWrites.set(key, pending);
    try {
      await pending;
    } finally {
      if (this.scopeWrites.get(key) === pending) this.scopeWrites.delete(key);
    }
  }
  drain() {
    if (this.pending) return this.pending;
    if (this.closed) return Promise.resolve();
    this.pending = this.processJobs().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  async processJobs() {
    for (const job of this.store
      .list("brain-job")
      .filter(
        (j) => j.status === "queued" && (!j.retryAt || j.retryAt <= Date.now()),
      )) {
      if (this.closed) return;
      const project = this.store.get("project", job.projectId);
      if (project.removedAt) {
        this.store.patch("brain-job", job.id, { status: "paused" });
        continue;
      }
      this.store.patch("brain-job", job.id, {
        status: "running",
        startedAt: now(),
      });
      try {
        for (const turn of this.store
          .list("brain-turn")
          .filter(
            (t) =>
              t.projectId === project.id && (!t.finishedAt || t.receiptPending),
          )) {
          if (turn.receiptPending) {
            await this.flushReceipt(project, turn);
            continue;
          }
          const run = this.store.get("run", turn.runId);
          if (
            !run.deletedAt &&
            run.attempt === turn.attempt &&
            [
              "review",
              "failed",
              "paused",
              "interrupted",
              "accepted",
              "cancelled",
            ].includes(run.status)
          )
            await this.turnReceipt(project, run);
        }
        await this.indexProject(project);
        if (this.store.get("brain-job", job.id).generation === job.generation)
          this.store.patch("brain-job", job.id, {
            status: this.closed ? "queued" : "complete",
            finishedAt: now(),
            error: null,
          });
      } catch (error) {
        if (this.store.get("brain-job", job.id).generation === job.generation)
          this.store.patch("brain-job", job.id, {
            status: job.attempts < 2 ? "queued" : "failed",
            attempts: job.attempts + 1,
            retryAt: Date.now() + 5000 * (job.attempts + 1),
            error: redact(error.message),
          });
      }
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.pending;
    await Promise.allSettled([...this.scopeWrites.values()]);
    await Promise.allSettled([...this.turnWrites.values()]);
  }
  async beforeTurn(project, run) {
    if (!run.worktree) return;
    const attempt = run.attempt + 1;
    this.store.put("brain-turn", {
      id: `${run.id}:${attempt}`,
      projectId: project.id,
      runId: run.id,
      attempt,
      startedAt: now(),
    });
    const before = await capture(run.worktree);
    const scope = await scopeFor(run.worktree);
    await this.publishIndex(
      project,
      { scope, label: run.branch || "Working folder", root: run.worktree },
      before,
    );
    const overlapping = this.store
      .list("run")
      .some(
        (r) =>
          r.id !== run.id &&
          r.worktree === run.worktree &&
          ["preparing", "running", "validating"].includes(r.status),
      );
    this.store.put("brain-turn", {
      id: `${run.id}:${attempt}`,
      projectId: project.id,
      runId: run.id,
      attempt,
      scope,
      before,
      startedAt: now(),
      overlapping,
    });
    this.store.patch("run", run.id, { brainScope: scope });
  }
  async turnReceipt(project, run) {
    const key = `${run.id}:${run.attempt}`;
    if (this.turnWrites.has(key)) return this.turnWrites.get(key);
    const pending = this.recordTurnReceipt(project, run);
    this.turnWrites.set(key, pending);
    try {
      await pending;
    } finally {
      if (this.turnWrites.get(key) === pending) this.turnWrites.delete(key);
    }
  }
  async recordTurnReceipt(project, run) {
    if (!run.worktree || !run.attempt) return;
    const key = `${run.id}:${run.attempt}`;
    const old = this.store.list("brain-turn").find((t) => t.id === key);
    if (old?.finishedAt) {
      if (old.receiptPending) await this.flushReceipt(project, old);
      this.enqueue(project, "validation or acceptance");
      return;
    }
    const after = await capture(run.worktree);
    const delta = compareSnapshots(old?.before, after);
    const overlap =
      old?.overlapping ||
      this.store
        .list("run")
        .some(
          (r) =>
            r.id !== run.id &&
            r.worktree === run.worktree &&
            r.startedAt &&
            (!r.finishedAt || r.finishedAt >= old?.startedAt),
        );
    const scope = old?.scope || (await scopeFor(run.worktree));
    const filename = `Turn ${run.id} ${run.attempt}.md`;
    const changes = [
      ...delta.added.map(
        (p) => `- ${delta.partial ? "Newly indexed" : "Added"}: \`${p}\``,
      ),
      ...delta.modified.map((p) => `- Modified: \`${p}\``),
      ...delta.removed.map(
        (p) => `- ${delta.partial ? "No longer indexed" : "Deleted"}: \`${p}\``,
      ),
      ...delta.renamed.map(
        (p) =>
          `- Rename candidate (identical content): \`${p.from}\` → \`${p.to}\``,
      ),
    ].join("\n");
    const evidence = delta.evidence
      .map(
        (e) =>
          `### ${e.path}\n\nLine samples (not a complete patch):\n\n${e.removed.map((l) => `> − ${l}`).join("\n")}\n${e.added.map((l) => `> + ${l}`).join("\n")}`,
      )
      .join("\n\n");
    const saveReceipt = async (p, file, content) => {
      // Save the exact observed result before touching Markdown. A restart can
      // retry this write without recapturing later, unrelated workspace edits.
      const turn = this.store.put("brain-turn", {
        id: key,
        projectId: project.id,
        runId: run.id,
        attempt: run.attempt,
        scope,
        beforeSnapshot: old?.before?.snapshot,
        afterSnapshot: after.snapshot,
        delta,
        overlapping: !!overlap,
        finishedAt: now(),
        filename: file,
        receiptPending: true,
        receiptContent: content,
      });
      await this.flushReceipt(p, turn);
    };
    await saveReceipt(
      project,
      filename,
      `---\nkind: session-receipt\nscope: ${scope}\nsource_commit: ${after.head}\nsource_snapshot: ${after.snapshot}\nverification: observed-events\nupdated: ${now()}\n---\n\n# ${run.title} · turn ${run.attempt}\n\n## Request\n\n${run.followup || run.prompt}\n\n## Observed changes\n\n${delta.unknown ? "Start snapshot unavailable. Changes cannot be attributed to this turn." : changes || "No changes in the indexed text files."}\n\nCompared workspace snapshots, not authorship. ${overlap ? "Concurrent activity was observed: attribution is ambiguous." : "External edits during the turn cannot be distinguished from agent edits."} Existing edits in the start snapshot are not credited to this turn. Coverage exclusions: ${after.skipped}.\n\n## Handoff (agent-reported, not independently verified)\n\n${run.summary || "No final response received."}\n\n## Recorded checks\n\n${run.validation ? `${run.validation.status}: ${run.validation.command || "configured check"}` : "No validation recorded at turn completion."}\n\n${evidence}\n\nRelated: [[Code Architecture ${scope.slice(-8)}]] · [[Session ${run.id.slice(0, 8)}]]\n`,
    );
    this.enqueue(project, "chat completed");
  }
  async flushReceipt(project, turn) {
    await this.generated(project, turn.filename, turn.receiptContent);
    this.store.patch("brain-turn", turn.id, {
      receiptPending: false,
      receiptContent: null,
    });
  }
  path(project) {
    return join(this.root, project.id);
  }
  async write(project, filename, content) {
    if (!/^[a-zA-Z0-9 _.-]+\.md$/.test(filename) || filename.includes(".."))
      throw new Error("Invalid note name.");
    await mkdir(this.path(project), { recursive: true, mode: 0o700 });
    const temporary = join(this.path(project), `.write-${randomUUID()}`);
    const handle = await open(
      temporary,
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
    try {
      await rename(temporary, join(this.path(project), filename));
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
  async refresh(project) {
    const revision = await projectRevision(
      this.store.get("project", project.id),
    );
    const head = revision.head;
    this.store.patch("project", project.id, { brainRef: revision.ref });
    const files = (
      await git(project.path, ["ls-tree", "-r", "--name-only", head])
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
        await git(project.path, ["show", `${head}:package.json`]),
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
    this.enqueue(project, "project import or refresh");
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
      await projectRevision(this.store.get("project", project.id)).catch(
        () => ({ head: "" }),
      )
    ).head;
    const indexes = this.store
      .list("brain-scope")
      .filter((i) => i.projectId === project.id);
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
          const metadata =
            content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || "";
          const source = metadata.match(/^source_commit: (.+)$/m)?.[1];
          const scope =
            metadata.match(/^scope: (.+)$/m)?.[1] ||
            (/^kind: session-receipt$/m.test(metadata)
              ? "legacy-session"
              : "project");
          const snapshot = metadata.match(/^source_snapshot: (.+)$/m)?.[1];
          const index = indexes.find((i) => i.scope === scope);
          const indexed = /^verification: static-analysis$/m.test(metadata);
          const membership = index?.notes?.find((n) => n.filename === filename);
          if (
            indexed &&
            (!index ||
              index.archived ||
              !index.notes.some((n) => n.filename === filename))
          )
            return null;
          return {
            filename,
            title: indexed
              ? `${content.match(/^# (.+)$/m)?.[1]?.replace(/ [a-f0-9]{6}$/, "") || basename(filename, ".md")}${scope !== "project" ? ` · ${index?.label || "worktree"}` : ""}`
              : basename(filename, ".md"),
            content,
            generated: /^kind: (?:generated|session-receipt)$/m.test(metadata),
            proposal: /^kind: proposal$/m.test(metadata),
            approved: /^verification: human-approved$/m.test(metadata),
            stale: indexed
              ? !index ||
                index.archived ||
                membership?.fingerprint !== knowledgeFingerprint(content) ||
                (scope === "project" && index.head !== current)
              : scope !== "project"
                ? !index ||
                  index.archived ||
                  (!!snapshot && snapshot !== index.snapshot)
                : /^kind: (?:generated|session-receipt|proposal)$/m.test(
                    metadata,
                  ) &&
                  !!source &&
                  source !== current,
            source,
            scope,
            snapshot,
            verifiedAt: index?.updatedAt,
            topic: index?.notes?.find((n) => n.filename === filename)?.topic,
            pending: scope !== "project",
            archived: !!index?.archived,
            links: [...content.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]),
          };
        }),
    );
    return notes.filter(Boolean);
  }
  async selectContext(
    project,
    query = "",
    { pinned = [], excluded = [], budget = 12000, scope = "project" } = {},
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
    const overlayTopics = new Set(
      notes
        .filter((n) => n.scope === scope && scope !== "project" && !n.stale)
        .map((n) => n.topic)
        .filter(Boolean),
    );
    const inScope = (n) =>
      (n.scope === "project" || n.scope === scope) &&
      !(n.scope === "project" && overlayTopics.has(n.topic)) &&
      !(
        scope !== "project" &&
        overlayTopics.size &&
        ["Repository map.md", "Development.md"].includes(n.filename)
      );
    const candidates = notes
      .filter(
        (n) =>
          inScope(n) &&
          !n.stale &&
          !n.proposal &&
          !excluded.includes(n.filename),
      )
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
        .filter(
          (n) =>
            !inScope(n) ||
            n.stale ||
            n.proposal ||
            excluded.includes(n.filename),
        )
        .map((n) => ({
          filename: n.filename,
          reason: !inScope(n)
            ? "different worktree or superseded by current worktree"
            : n.stale
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
    const scope =
      run.brainScope ||
      (run.worktree
        ? await scopeFor(run.worktree).catch(() => "legacy-session")
        : "legacy-session");
    const write = (p, filename, content) =>
      this.write(
        p,
        filename,
        content.replace(
          "kind: session-receipt\n",
          `kind: session-receipt\nscope: ${scope}\n`,
        ),
      );
    await write(
      project,
      `Session ${run.id.slice(0, 8)}.md`,
      `---\nkind: session-receipt\nsource_commit: ${run.base || "unknown"}\nupdated: ${now()}\nverification: observed-events\n---\n\n# ${run.title}\n\n## Objective\n\n${run.prompt}\n\n## Outcome\n\nStatus: **${run.status}**. This is a run receipt, not an independently verified success claim.\n\n## Codex handoff\n\n${run.summary || "No final response received."}\n\n## Changed files\n\n${(run.files || []).map((f) => `- \`${f}\``).join("\n") || "No changed files recorded."}\n\n## Evidence\n\n- Fleet session: \`${run.id}\`\n- Codex thread: \`${run.threadId || "not received"}\`\n- Worktree branch: \`${run.branch || "not created"}\`\n- Validation: ${run.validation?.status || "not run"}\n\nRelated: [[Home]]\n`,
    );
    await this.turnReceipt(project, run).catch((error) => {
      this.store.event(project.id, run.id, "brain.receipt.error", {
        message: redact(error.message),
      });
      this.enqueue(project, "receipt retry");
    });
  }
}
