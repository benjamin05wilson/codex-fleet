import xterm from "@xterm/headless";
const { Terminal } = xterm;

// Use the same terminal parser family as Fleet's UI, including cursor queries.
// Replay Fleet's retained events so output emitted during open is not lost.
export function headlessTerminal(session, { cols = 100, rows = 30 } = {}) {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true });
  let sequence = 0,
    transcript = "",
    closed = false;
  const responses = terminal.onData((data) => {
    if (!closed && !session.closing && session.exitCode === undefined)
      session.process.write(data);
  });
  const replay = () => {
    for (const event of session.events) {
      if (event.seq <= sequence) continue;
      sequence = event.seq;
      transcript += event.data;
      terminal.write(event.data);
    }
  };
  const subscription = session.process.onData(replay);
  replay();
  return {
    get transcript() {
      return transcript;
    },
    get text() {
      const buffer = terminal.buffer.active;
      return Array.from({ length: buffer.length }, (_, i) =>
        buffer.getLine(i).translateToString(true),
      )
        .join("\n")
        .trimEnd();
    },
    flush: () => new Promise((resolve) => terminal.write("", resolve)),
    resize: (cols, rows) => terminal.resize(cols, rows),
    close() {
      if (closed) return;
      closed = true;
      subscription.dispose();
      responses.dispose();
      terminal.dispose();
    },
  };
}
