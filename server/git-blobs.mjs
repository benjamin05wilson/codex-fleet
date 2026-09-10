import { spawn } from "node:child_process";

// One bounded, lazy cat-file process per snapshot, not one process per file.
// Object IDs/sizes come from ls-tree. No filters, textconv or symlink following.
export class GitBlobs {
  constructor(root) {
    this.root = root;
  }
  start() {
    this.child = spawn(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        this.root,
        "cat-file",
        "--batch",
      ],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_NO_REPLACE_OBJECTS: "1",
        },
      },
    );
    this.buffer = Buffer.alloc(0);
    this.input = this.child.stdout[Symbol.asyncIterator]();
    this.child.stdin.on("error", () => {});
    this.child.stderr.resume();
    this.child.on("error", (error) => {
      this.error = error;
    });
    this.closed = new Promise((resolve) => this.child.once("close", resolve));
    this.timer = setTimeout(() => {
      this.error = new Error("Git blob snapshot timed out after 30000ms");
      this.child.kill("SIGKILL");
    }, 30000);
  }
  async more() {
    const { value, done } = await this.input.next();
    if (done) throw this.error || new Error("Git blob stream ended early");
    this.buffer = Buffer.concat([this.buffer, value]);
  }
  async read(object, expectedSize, limit) {
    if (
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(object) ||
      !Number.isSafeInteger(limit) ||
      limit < 0 ||
      !Number.isSafeInteger(expectedSize) ||
      expectedSize < 0 ||
      expectedSize > limit
    )
      throw new Error("Invalid or over-budget Git blob request");
    if (!this.child) this.start();
    this.child.stdin.write(object + "\n");
    while (!this.buffer.includes(10)) {
      if (this.buffer.length > 200) throw new Error("Invalid Git blob header");
      await this.more();
    }
    const newline = this.buffer.indexOf(10);
    const header = this.buffer.subarray(0, newline).toString("ascii");
    if (header !== `${object} blob ${expectedSize}`)
      throw new Error("Git blob identity, type or size changed");
    this.buffer = this.buffer.subarray(newline + 1);
    while (this.buffer.length < expectedSize + 1) await this.more();
    if (this.buffer[expectedSize] !== 10)
      throw new Error("Invalid Git blob framing");
    const value = this.buffer.subarray(0, expectedSize).toString("utf8");
    this.buffer = this.buffer.subarray(expectedSize + 1);
    return value;
  }
  async close() {
    if (!this.child) return;
    // The async iterator may be paused with unread bytes after a bad frame.
    // Destroy owned pipes explicitly or child `close` can wait on that reader.
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.kill();
    await this.closed;
    clearTimeout(this.timer);
  }
}
