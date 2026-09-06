import { now } from "./store.mjs";
import { codingDefault, validatePermissions } from "../shared/permissions.mjs";

export function onboardingSettings(store) {
  return store.list("preferences").find((p) => p.id === "onboarding") || null;
}
export function saveOnboarding(store, input) {
  if (input.approved !== true)
    throw new Error("Confirm your Fleet defaults before saving.");
  const sandbox = validatePermissions({ sandbox: codingDefault, ...input });
  // Preserve legacy workflow preferences when the new UI saves permissions only.
  const legacy = {};
  const previous = onboardingSettings(store);
  for (const key of ["model", "workspaceMode", "suggestTeam", "includeMemory"])
    if (Object.hasOwn(input, key)) legacy[key] = input[key];
    else if (previous && Object.hasOwn(previous, key))
      legacy[key] = previous[key];
  if (
    Object.hasOwn(legacy, "model") &&
    (typeof legacy.model !== "string" || legacy.model.length > 150)
  )
    throw new Error("Invalid default model.");
  if (
    Object.hasOwn(legacy, "workspaceMode") &&
    !["worktree", "main"].includes(legacy.workspaceMode)
  )
    throw new Error("Choose a default working folder.");
  if (
    (Object.hasOwn(legacy, "suggestTeam") &&
      typeof legacy.suggestTeam !== "boolean") ||
    (Object.hasOwn(legacy, "includeMemory") &&
      typeof legacy.includeMemory !== "boolean")
  )
    throw new Error("Invalid project team preferences.");
  return store.put("preferences", {
    id: "onboarding",
    version: 1,
    completedAt: now(),
    sandbox,
    ...legacy,
    ...(typeof legacy.model === "string" ? { model: legacy.model.trim() } : {}),
    yoloApproved: sandbox === "danger-full-access",
  });
}
export function newSessionDefaults(store, project) {
  const global = onboardingSettings(store);
  const saved =
    project?.sessionDefaults ||
    (project?.kind === "scratch" || !project
      ? store.list("preferences").find((p) => p.id === "scratch-session")
      : null);
  return {
    sandbox: global?.sandbox || codingDefault,
    model: global?.model || "",
    yoloApproved: global?.yoloApproved === true,
    useTeam: false,
    ...saved,
  };
}
