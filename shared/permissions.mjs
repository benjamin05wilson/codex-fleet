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
