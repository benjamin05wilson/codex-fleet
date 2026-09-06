import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, chmodSync } from "node:fs";
import { EventEmitter } from "node:events";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const id = () => randomUUID();
export const now = () => new Date().toISOString();

export class Store {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const existed = existsSync(path);
    this.changes = new EventEmitter();
    this.changes.setMaxListeners(100);
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    const version = this.db.prepare("PRAGMA user_version").get().user_version;
    if (version > 1) {
      this.db.close();
      throw new Error("This Fleet database needs a newer application.");
    }
    if (existed && version === 0) {
      const objects = this.db
        .prepare("SELECT name FROM sqlite_master WHERE name='objects'")
        .get();
      if (objects) {
        const active = this.db
          .prepare("SELECT data FROM objects WHERE kind='run'")
          .all()
          .some((row) =>
            [
              "running",
              "preparing",
              "pausing",
              "validating",
              "accepting",
            ].includes(JSON.parse(row.data).status),
          );
        if (active) {
          this.db.close();
          throw new Error(
            "Finish or explicitly stop legacy active runs before upgrading Fleet.",
          );
        }
      }
      const backup = `${path}.pre-v1-${Date.now()}.sqlite`;
      this.db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
      chmodSync(backup, 0o600);
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS objects (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, project_id TEXT NOT NULL, time TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id,seq);
      CREATE TABLE IF NOT EXISTS requests (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL, response TEXT);
      PRAGMA user_version=1;
    `);
  }
  put(kind, value) {
    this.db
      .prepare(
        "INSERT INTO objects VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      )
      .run(kind, value.id, JSON.stringify(value));
    this.changes.emit("change", { kind, id: value.id });
    return value;
  }
  get(kind, key) {
    const row = this.db
      .prepare("SELECT data FROM objects WHERE kind=? AND id=?")
      .get(kind, key);
    if (!row)
      throw Object.assign(new Error(`${kind} not found`), { status: 404 });
    return JSON.parse(row.data);
  }
  list(kind) {
    return this.db
      .prepare("SELECT data FROM objects WHERE kind=? ORDER BY rowid DESC")
      .all(kind)
      .map((r) => JSON.parse(r.data));
  }
  patch(kind, key, changes) {
    return this.put(kind, {
      ...this.get(kind, key),
      ...changes,
      updatedAt: now(),
    });
  }
  event(projectId, runId, type, data = {}) {
    const time = now();
    const result = this.db
      .prepare(
        "INSERT INTO events(run_id,project_id,time,type,data) VALUES(?,?,?,?,?)",
      )
      .run(runId, projectId, time, type, JSON.stringify(data));
    const event = {
      seq: Number(result.lastInsertRowid),
      runId,
      projectId,
      time,
      type,
      data,
    };
    this.changes.emit("event", event);
    this.changes.emit("change", { kind: "event", id: event.seq });
    return event;
  }
  replay(after = 0, limit = 500) {
    return this.db
      .prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?")
      .all(after, limit)
      .map((r) => ({
        seq: r.seq,
        runId: r.run_id,
        projectId: r.project_id,
        time: r.time,
        type: r.type,
        data: JSON.parse(r.data),
      }));
  }
  events({
    runId,
    projectId,
    after = 0,
    before = Number.MAX_SAFE_INTEGER,
    limit = 500,
  } = {}) {
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE seq > ? AND seq < ? ${runId ? "AND run_id=?" : projectId ? "AND project_id=?" : ""} ORDER BY seq DESC LIMIT ?`,
      )
      .all(
        ...[
          after,
          before,
          ...(runId ? [runId] : projectId ? [projectId] : []),
          limit,
        ],
      );
    return rows.reverse().map((r) => ({
      seq: r.seq,
      runId: r.run_id,
      projectId: r.project_id,
      time: r.time,
      type: r.type,
      data: JSON.parse(r.data),
    }));
  }
  close() {
    this.db.close();
  }
}
