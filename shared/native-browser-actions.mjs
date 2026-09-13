export const nativeBrowserActions = [
  "tabs",
  "new_tab",
  "switch_tab",
  "close_tab",
  "snapshot",
  "screenshot",
  "navigate",
  "back",
  "forward",
  "reload",
  "click",
  "fill",
  "upload",
  "press",
  "scroll",
];
export function validateNativeAction(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (k) => !["action", "target", "text", "url", "files", "tabId"].includes(k),
    ) ||
    !nativeBrowserActions.includes(input.action)
  )
    throw new Error("Unsupported native browser action.");
  for (const key of ["target", "text", "url", "tabId"])
    if (input[key] !== undefined && typeof input[key] !== "string")
      throw new Error("Invalid browser input.");
  if (
    ["click", "fill", "upload"].includes(input.action) &&
    !/^@e\d{1,30}$/.test(input.target || "")
  )
    throw new Error("Use an element reference from the latest snapshot.");
  if (input.action === "fill" && typeof input.text !== "string")
    throw new Error("Text is required.");
  if (
    ["navigate", "new_tab"].includes(input.action) &&
    typeof input.url !== "string"
  )
    throw new Error("URL is required.");
  if (
    input.action === "scroll" &&
    !["up", "down", "left", "right"].includes(input.text)
  )
    throw new Error("Choose a scroll direction.");
  if (
    input.action === "press" &&
    ![
      "Enter",
      "Tab",
      "Escape",
      "Backspace",
      "Delete",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "Space",
      "Control+a",
      "Meta+a",
    ].includes(input.text)
  )
    throw new Error("Unsupported key.");
  if (
    input.action === "upload" &&
    (!Array.isArray(input.files) ||
      !input.files.every(
        (p) => typeof p === "string" && /^(\/|[A-Za-z]:[\\/])/.test(p),
      ))
  )
    throw new Error("Upload requires absolute file paths.");
  if (
    ["switch_tab", "close_tab"].includes(input.action) &&
    typeof input.tabId !== "string"
  )
    throw new Error("Tab ID is required.");
  return input;
}
