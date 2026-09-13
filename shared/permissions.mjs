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
  return sandbox;
}

export function turnPermissionInstructions(run) {
  const sandbox = validatePermissions(run);
  const policy =
    sandbox === "danger-full-access"
      ? "YOLO full access is enabled with the user's acknowledgement. Run commands, access the network, install software and modify files as needed for the user's authorized task. The working folder is a starting location, not an access boundary. OS permissions still apply."
      : sandbox === "read-only"
        ? "Use the configured read-only sandbox. If the user's task needs additional access, request it through the approval flow."
        : "Use the configured workspace sandbox. If the user's task needs additional access, request it through the approval flow.";
  return `Current Fleet permission policy for this turn (supersedes earlier Fleet-generated permission instructions):\n${policy}\nFollow the user's requested scope, including authorized commits, pushes, deployments and credential use. Do not expose secrets. Leave unrequested publication or unrelated changes for the user to decide.`;
}
