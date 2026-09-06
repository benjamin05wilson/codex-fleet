// Product safety defaults, shared by enforcement and capability reporting.
export const limits = Object.freeze({
  tasks: 5,
  attempts: 2,
  timeoutMs: 30 * 60_000,
});
