import { acquireDaemonLock } from "../../server/daemon-lock.mjs";
try {
  const lease = acquireDaemonLock(process.argv[2]);
  process.send({ owned: true, owner: lease.owner });
  process.on("message", (message) => {
    if (message === "release") {
      lease.release();
      process.exit(0);
    }
    if (message === "crash") process.exit(0); // No application cleanup.
  });
} catch (error) {
  process.send({ owned: false, code: error.code, message: error.message }, () =>
    process.exit(0),
  );
}
