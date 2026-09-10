import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  realpathSync,
  openSync,
  closeSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const alreadyRunning = () =>
  Object.assign(
    new Error("Fleet is already running for this data directory."),
    { code: "FLEET_ALREADY_RUNNING" },
  );

function legacyOwner(pid) {
  // This process cannot be a competing legacy daemon. Current-format owners,
  // including reentrant acquisition, are already excluded by SQLite above.
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
  // A PID by itself is not identity. This is only for migrating the old bare
  // PID file; new instances are arbitrated by the OS-backed SQLite lock.
  const command =
    process.platform === "win32"
      ? execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
          ],
          { encoding: "utf8", windowsHide: true, timeout: 5000 },
        )
      : execFileSync("ps", ["-p", String(pid), "-o", "command="], {
          encoding: "utf8",
          timeout: 5000,
        });
  return /(?:^|[\s"'\\/])server[\\/]index\.mjs(?:["'\s]|$)/.test(
    command.trim(),
  );
}

export function acquireDaemonLock(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const directory = realpathSync(dataDir);
  const lock = join(directory, "daemon.lock");
  const arbitration = join(directory, "daemon-owner.sqlite");
  // Never unlink this database: all contenders must lock the same inode.
  // Do not open/close an existing arbitration file outside SQLite: on POSIX,
  // closing any descriptor for that inode can release this process's locks.
  try {
    closeSync(openSync(arbitration, "wx", 0o600));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  chmodSync(arbitration, 0o600);
  const db = new DatabaseSync(arbitration);
  try {
    db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
  } catch (error) {
    db.close();
    if (
      error.errcode === 5 ||
      error.errcode === 6 ||
      /locked|busy/i.test(error.message)
    )
      throw alreadyRunning();
    throw error;
  }
  const owner = {
    version: 1,
    pid: process.pid,
    nonce: randomUUID(),
    processStartedAt: new Date(
      Date.now() - process.uptime() * 1000,
    ).toISOString(),
    acquiredAt: new Date().toISOString(),
  };
  const identity = JSON.stringify(owner);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      // Keep arbitration until cleanup is complete. A delayed old owner can
      // never unlink the metadata of a replacement instance.
      if (readFileSync(lock, "utf8") === identity) unlinkSync(lock);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    } finally {
      db.close();
    }
  };
  try {
    let fd;
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const previous = readFileSync(lock, "utf8");
      const pid = /^\d+$/.test(previous.trim()) ? Number(previous.trim()) : 0;
      if (
        Number.isSafeInteger(pid) &&
        pid > 0 &&
        pid <= 2147483647 &&
        legacyOwner(pid)
      )
        throw alreadyRunning();
      // Holding the exclusive lifetime lock proves no new-format owner is
      // alive, even when metadata contains a reused live PID or is malformed.
      unlinkSync(lock);
      fd = openSync(lock, "wx", 0o600);
    }
    try {
      // Write via the exclusively created descriptor, never via a reopened path.
      writeFileSync(fd, identity);
    } finally {
      closeSync(fd);
    }
    return { owner, release };
  } catch (error) {
    release();
    throw error;
  }
}
