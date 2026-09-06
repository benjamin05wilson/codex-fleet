import { safeRead } from "./git.mjs";
import { createHash } from "node:crypto";

// These are targeted heuristics, not a substitute for SAST or an execution boundary.
const secret =
  /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{24,}|AKIA[A-Z0-9]{16})\b/g;
export function redact(text) {
  return String(text)
    .replace(secret, "[REDACTED CREDENTIAL]")
    .replace(
      /(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)[\s\S]*?(-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/g,
      "[REDACTED PRIVATE KEY]",
    );
}
export function redactValue(value) {
  return JSON.parse(redact(JSON.stringify(value)));
}
const rules = [
  {
    id: "secret",
    title: "Possible credential in source",
    severity: "high",
    pattern:
      /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{24,}|AKIA[A-Z0-9]{16})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    advice:
      "Remove this value and review whether rotation is needed. Use a secret manager or environment reference.",
  },
  {
    id: "tls",
    title: "TLS verification disabled",
    severity: "high",
    pattern:
      /verify\s*=\s*False|rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/,
    advice:
      "Keep certificate verification enabled; configure the trusted certificate instead.",
  },
  {
    id: "eval",
    title: "Dynamic code evaluation",
    severity: "medium",
    pattern: /\beval\s*\(|new Function\s*\(/,
    advice:
      "Check whether untrusted input reaches this call. Prefer a constrained parser.",
  },
  {
    id: "shell",
    title: "Shell execution enabled",
    severity: "medium",
    pattern: /shell\s*[:=]\s*(?:true|True)/,
    advice:
      "Confirm arguments cannot contain untrusted shell syntax. Prefer an executable and argument array.",
  },
  {
    id: "cors",
    title: "Unrestricted CORS origin",
    severity: "medium",
    pattern: /(?:allow_origins|origin)\s*[:=]\s*(?:\[\s*)?['"]\*['"]/,
    advice:
      "Verify this endpoint is intentionally public before permitting every origin.",
  },
  {
    id: "privileged",
    title: "Privileged runtime requested",
    severity: "high",
    pattern: /privileged\s*:\s*true|\/var\/run\/docker\.sock/,
    advice:
      "This may expose the host. Check whether the capability is needed and isolate the workload.",
  },
];
export function scanText(file, content) {
  const findings = [];
  for (const [index, line] of content.split("\n").entries())
    for (const rule of rules)
      if (rule.pattern.test(line)) {
        findings.push({
          rule: rule.id,
          title: rule.title,
          severity: rule.severity,
          path: file,
          line: index + 1,
          evidence: redact(line.trim()).slice(0, 240),
          advice: rule.advice,
          state: "suspected",
        });
      }
  return findings;
}
export function scanCommand(command) {
  if (
    /\bcurl\b[\s\S]*\|\s*(?:sh|bash)\b|\bgit\s+push[^\n]*--force|\bterraform\s+destroy|\brm\s+-[a-zA-Z]*r[a-zA-Z]*f\s/.test(
      command,
    )
  )
    return {
      rule: "command",
      title: "Potentially destructive command observed",
      severity: "high",
      path: "Codex event stream",
      line: null,
      evidence: redact(command).slice(0, 240),
      advice:
        "This is an audit observation. Inspect the command result and its resolved targets. Codex sandbox policy governs execution.",
      state: "suspected",
    };
  return null;
}
export const fingerprint = (f) =>
  createHash("sha256")
    .update([f.rule, f.path, f.line, f.evidence].join("|"))
    .digest("hex")
    .slice(0, 24);
export async function scanChanges(run, files, coverage = {}) {
  const findings = [];
  coverage.checked = [];
  coverage.skipped = [];
  for (const file of files.slice(0, 300)) {
    if (
      /(?:^|\/)(?:node_modules|vendor|\.git)\//.test(file) ||
      /(?:package-lock\.json|\.svg|\.lock)$/.test(file)
    ) {
      coverage.skipped.push(file);
      continue;
    }
    let missing = false;
    const content = await safeRead(run.worktree, file).catch((error) => {
      missing = error.code === "ENOENT";
      return null;
    });
    if (content !== null || missing) coverage.checked.push(file);
    else coverage.skipped.push(file);
    if (content !== null) findings.push(...scanText(file, content));
    if (
      run.scopes?.length &&
      !run.scopes.some(
        (scope) =>
          file === scope || file.startsWith(scope.replace(/\/$/, "") + "/"),
      )
    ) {
      findings.push({
        rule: "scope",
        title: "Change outside declared scope",
        severity: "medium",
        path: file,
        line: null,
        evidence: file,
        advice:
          "Review whether this change belongs to the approved task. Declared scopes are advisory in this release.",
        state: "suspected",
      });
    }
  }
  return findings;
}
