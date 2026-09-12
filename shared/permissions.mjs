export const permissionModes = [
  {
    id: "read-only",
    title: "Read only",
    summary: "Explore and plan without editing files.",
  },
  {
    id: "workspace-write",
    title: "Standard",
    summary: "Automatically edit project files and run sandboxed commands.",
  },
  {
    id: "danger-full-access",
    title: "YOLO",
    summary: "No sandbox or approval prompts. Full local-user access.",
  },
];
export const codingDefault = "workspace-write";
export const onboardingModes = permissionModes.filter(
  (mode) => mode.id !== "read-only",
);
export const yoloWarning =
  "YOLO can run commands, access the network and change files outside your project, including deleting data or exposing credentials. A Git worktree is not a security boundary. Use only in an environment you trust.";
export function validatePermissions(input) {
  const sandbox = input.sandbox || "read-only";
  if (!permissionModes.some((mode) => mode.id === sandbox))
    throw new Error("Unsupported sandbox.");
  if (sandbox === "danger-full-access" && input.yoloApproved !== true)
    throw new Error(
      "Explicitly acknowledge full-access YOLO permissions first.",
    );
  if (
    sandbox === "danger-full-access" &&
    (input.teamId ||
      input.teamRole ||
      input.workflowId ||
      input.missionId ||
      input.reviewOf)
  )
    throw new Error("YOLO is only available for independent chats.");
  return sandbox;
}

export function turnPermissionInstructions(run) {
  const sandbox = validatePermissions(run);
  const policy =
    sandbox === "danger-full-access"
      ? "YOLO full access is enabled with the user's acknowledgement. You may run commands, access the network, install software and modify files outside this working folder when needed for the user's authorized task. The working folder is a starting location, not an access boundary. Do not expose secrets; access credentials only when necessary for the user's authorized task. Do not push, deploy, merge into the source repository, or commit unless the user explicitly requests it. Otherwise leave changes for human review. OS permissions still apply."
      : `Do not push, deploy, merge into the source repository, or commit. Leave changes for human review. Do not read credentials or modify files outside this working folder.${sandbox === "read-only" ? " This is a read-only turn: do not modify files or install software." : " Use the configured workspace sandbox for commands."}`;
  return `Current Fleet permission policy for this turn (supersedes earlier Fleet-generated permission instructions):\n${policy}`;
}
