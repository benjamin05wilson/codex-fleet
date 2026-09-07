export const nativeBrowserActions = [
  "snapshot",
  "screenshot",
  "navigate",
  "back",
  "forward",
  "reload",
  "click",
  "fill",
  "press",
  "scroll",
];
export function validateNativeAction(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (k) => !["action", "target", "text", "url"].includes(k),
    ) ||
    !nativeBrowserActions.includes(input.action)
  )
    throw new Error("Unsupported native browser action.");
  for (const key of ["target", "text", "url"])
    if (
      input[key] !== undefined &&
      (typeof input[key] !== "string" || input[key].length > 4000)
    )
      throw new Error("Invalid browser input.");
  if (
    ["click", "fill"].includes(input.action) &&
    !/^@e\d{1,30}$/.test(input.target || "")
  )
    throw new Error("Use an element reference from the latest snapshot.");
  if (input.action === "fill" && typeof input.text !== "string")
    throw new Error("Text is required.");
  if (input.action === "navigate" && typeof input.url !== "string")
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
  return input;
}
