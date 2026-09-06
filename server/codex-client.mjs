import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

// Verified against the installed 0.153.2 schema; no experimental API opt-in.
export class CodexClient extends EventEmitter {
  constructor(bin = "codex", cwd = process.cwd()) {
    super();
    this.bin = bin;
    this.cwd = cwd;
    this.pending = new Map();
    this.sequence = 0;
  }
  async connect() {
    const env = Object.fromEntries(
      ["PATH", "HOME", "USER", "TMPDIR", "CODEX_HOME"]
        .filter((k) => process.env[k])
        .map((k) => [k, process.env[k]]),
    );
    this.child = spawn(
      this.bin,
      [
        "app-server",
        "-c",
        "sandbox_workspace_write.network_access=false",
        "-c",
        'approval_policy="never"',
      ],
      {
        cwd: this.cwd,
        env: { ...env, LANG: "en_US.UTF-8" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child.stdin.on("error", () => {});
    this.child.stderr.on("data", (b) => this.emit("diagnostic", b.toString()));
    const fail = (error) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timeout);
        p.reject(error);
      }
      this.pending.clear();
      this.emit("closed", error);
    };
    this.child.on("error", fail);
    this.child.on("close", (code) =>
      fail(new Error(`Codex app-server exited (${code ?? "unknown"}).`)),
    );
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => {
      if (line.length > 2_000_000) {
        this.close();
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.method && message.id !== undefined) {
        // No implicit escalation or automatic answers to permission requests.
        this.send({
          id: message.id,
          error: {
            code: -32000,
            message:
              "Fleet requires a new explicitly approved task for additional permissions.",
          },
        });
        this.emit("notification", {
          method: "fleet/permissionDenied",
          params: { method: message.method },
        });
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else if (message.method) this.emit("notification", message);
    });
    const result = await this.request(
      "initialize",
      { clientInfo: { name: "fleet_local", title: "Fleet", version: "0.2.0" } },
      15000,
    );
    this.send({ method: "initialized", params: {} });
    return result;
  }
  send(value) {
    if (this.child?.stdin.writable)
      this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  request(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.send({ id, method, params });
    });
  }
  close() {
    this.lines?.close();
    this.child?.kill("SIGTERM");
  }
}

export const sandboxPolicy = (cwd, mode = "workspace-write") => {
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (![true, false, "read-only", "workspace-write"].includes(mode))
    throw new Error("Unsupported sandbox policy.");
  return mode === true || mode === "read-only"
    ? { type: "readOnly" }
    : {
        type: "workspaceWrite",
        writableRoots: [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      };
};

export async function sandboxCheck(bin, cwd, command, signal) {
  const client = new CodexClient(bin, cwd);
  if (signal?.aborted) throw new Error("Validation cancelled.");
  const abort = () => client.close();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await client.connect();
    return await client.request(
      "command/exec",
      {
        command: ["/bin/sh", "-c", command],
        cwd,
        sandboxPolicy: sandboxPolicy(cwd),
        timeoutMs: 120000,
        outputBytesCap: 40000,
      },
      130000,
    );
  } finally {
    signal?.removeEventListener("abort", abort);
    client.close();
  }
}
