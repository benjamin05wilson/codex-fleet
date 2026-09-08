export function sessionActivityBlockedReason(run) {
  if (
    [
      "preparing",
      "running",
      "pausing",
      "validating",
      "accepting",
      "queued",
    ].includes(run.status)
  )
    return "Stop this session or remove it from the queue before deleting it.";
  if (run.shellOpen) return "Close the terminal before deleting this session.";
  if (["starting", "running", "stopping"].includes(run.preview?.status))
    return "Stop the preview before deleting this session.";
  return "";
}

export function deletionBlockedReason(run) {
  if (run.deletedAt) return "This chat is already in Trash.";
  const activity = sessionActivityBlockedReason(run);
  if (activity) return activity;
  return "";
}
