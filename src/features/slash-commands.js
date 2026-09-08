export const slashCommands = [
  { name: "help", description: "Show available chat commands" },
  {
    name: "model",
    description: "Choose the conversation model",
    settings: true,
  },
  {
    name: "permissions",
    description: "Change conversation permissions",
    settings: true,
  },
  {
    name: "settings",
    description: "Open conversation settings",
    settings: true,
  },
  { name: "diff", description: "Show changes and checks", tool: "review" },
  { name: "status", description: "Show session details", tool: "details" },
  { name: "files", description: "Browse session files", tool: "files" },
  { name: "browser", description: "Open the session browser", tool: "browser" },
  {
    name: "terminal",
    description: "Open the worktree shell",
    tool: "terminal",
  },
  { name: "stop", description: "Stop the current reply" },
];

// Match command-shaped input, while leaving absolute paths and multiline
// instructions available as ordinary chat messages.
export function parseSlashCommand(text) {
  const match = /^\/([a-z][\w-]*)(?:[ \t]+([^\r\n]*))?$/i.exec(text.trim());
  return match
    ? { name: match[1].toLowerCase(), args: match[2]?.trim() || "" }
    : null;
}

export function matchingSlashCommands(text) {
  const match = /^\/([a-z-]*)$/i.exec(text.trim());
  return match
    ? slashCommands.filter((command) =>
        command.name.startsWith(match[1].toLowerCase()),
      )
    : [];
}
