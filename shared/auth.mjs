export const signInMessage =
  "Sign in to Codex to continue. Your work and draft have been kept.";
export function validAuthURL(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      ["auth.openai.com", "auth0.openai.com", "chatgpt.com"].includes(
        url.hostname,
      )
    );
  } catch {
    return false;
  }
}
export function isAuthenticationError(message) {
  return /\b401\b|missing (?:bearer|authentication)|unauthorized|refresh.token.*(?:expired|invalid)|not (?:logged|signed) in/i.test(
    String(message),
  );
}
