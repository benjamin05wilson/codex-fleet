export const approvalMethods = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
];
export function approvalResponse(request, approved) {
  if (
    typeof approved !== "boolean" ||
    !approvalMethods.includes(request.method)
  )
    throw new Error("Invalid approval response.");
  if (request.method === "item/permissions/requestApproval")
    return {
      permissions: approved ? request.params.permissions : {},
      scope: "turn",
    };
  if (["execCommandApproval", "applyPatchApproval"].includes(request.method))
    return { decision: approved ? "approved" : "denied" };
  return { decision: approved ? "accept" : "decline" };
}
