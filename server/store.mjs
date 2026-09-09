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
    this.transactions = [];
    this.transactionSequence = 0;
    this.notifications = [];
    this.flushing = false;
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
  // SQLite and its notification stream share one commit boundary. Callbacks
  // must be synchronous: never hold a connection-wide transaction over await.
  transaction(fn) {
    if (fn?.constructor?.name === "AsyncFunction")
      throw new TypeError("Store transactions require a synchronous callback.");
    const nested = this.transactions.length > 0;
    const savepoint = `fleet_${++this.transactionSequence}`;
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    const pending = [];
    this.transactions.push(pending);
    let result;
    try {
      result = fn();
      if (result && typeof result.then === "function")
        throw new TypeError("Store transactions cannot return a Promise.");
      this.db.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
    } catch (error) {
      this.db.exec(
        nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK",
      );
      throw error;
    } finally {
      this.transactions.pop();
    }
    if (nested) this.transactions.at(-1).push(...pending);
    else {
      this.notifications.push(...pending);
      // Flush after the SQL try/catch: listener failures must never attempt to
      // roll back a transaction that has already committed.
      this.flushNotifications();
    }
    return result;
  }
  notify(name, value) {
    if (this.transactions.length) this.transactions.at(-1).push([name, value]);
    else {
      this.notifications.push([name, value]);
      this.flushNotifications();
    }
  }
  flushNotifications() {
    if (this.flushing) return;
    this.flushing = true;
    let failure;
    try {
      // Reentrant writes enqueue after the already committed notifications.
      for (let i = 0; i < this.notifications.length; i++) {
        try {
          this.changes.emit(...this.notifications[i]);
        } catch (error) {
          failure ||= error;
        }
      }
    } finally {
      this.notifications = [];
      this.flushing = false;
    }
    if (failure) throw failure;
  }
  put(kind, value) {
    this.assertManagedTransaction();
    this.db
      .prepare(
        "INSERT INTO objects VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      )
      .run(kind, value.id, JSON.stringify(value));
    this.notify("change", { kind, id: value.id });
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
    this.assertManagedTransaction();
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
    this.notify("event", event);
    this.notify("change", { kind: "event", id: event.seq });
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
  assertManagedTransaction() {
    if (this.db.isTransaction && !this.transactions.length)
      throw new Error(
        "Use Store.transaction() for transactional Store writes.",
      );
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
