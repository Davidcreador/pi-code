export const NATIVE_SLASH_COMMANDS = [
  { command: "model", description: "Switch response model for this thread" },
  { command: "plan", description: "Switch this thread into plan mode" },
  { command: "default", description: "Switch this thread back to normal build mode" },
  { command: "new", description: "Start a new thread" },
  { command: "tree", description: "Navigate the Pi session tree" },
  { command: "copy", description: "Copy the last assistant response" },
  { command: "compact", description: "Compact the Pi session context" },
  { command: "reload", description: "Reload the Pi session" },
  { command: "name", description: "Name the Pi session" },
  { command: "session", description: "Show Pi session state and statistics" },
  { command: "stats", description: "Show Pi session state and statistics" },
  { command: "export", description: "Export the Pi session as HTML" },
  { command: "quit", description: "Quit d4 (stop this session in a browser)" },
  { command: "hotkeys", description: "Show keyboard shortcuts" },
  { command: "settings", description: "Configure Pi settings" },
  { command: "scoped-models", description: "Configure models available to Pi" },
  { command: "resume", description: "Resume a Pi session" },
  { command: "import", description: "Import a Pi JSONL session" },
  { command: "fork", description: "Fork from a point in the Pi session tree" },
  { command: "clone", description: "Clone the current Pi session" },
  { command: "trust", description: "Configure trust for the current project" },
  { command: "changelog", description: "Show the bundled Pi changelog" },
  { command: "login", description: "Sign in to a Pi model provider" },
  { command: "logout", description: "Remove a credential saved by Pi" },
  { command: "share", description: "Share this Pi session with a secret GitHub gist" },
] as const;

export type NativeSlashCommand = (typeof NATIVE_SLASH_COMMANDS)[number]["command"];

export const PI_MANAGEMENT_COMMANDS = [
  "settings",
  "scoped-models",
  "resume",
  "import",
  "fork",
  "clone",
  "trust",
  "changelog",
  "login",
  "logout",
  "share",
] as const satisfies ReadonlyArray<NativeSlashCommand>;
export type PiManagementCommand = (typeof PI_MANAGEMENT_COMMANDS)[number];

const nativeCommandNames = new Set<string>(NATIVE_SLASH_COMMANDS.map(({ command }) => command));
const managementCommandNames = new Set<string>(PI_MANAGEMENT_COMMANDS);

export function parseNativeSlashCommand(text: string): NativeSlashCommand | null {
  const match = /^\/([^\s]+)(?:\s|$)/i.exec(text.trim());
  const command = match?.[1]?.toLowerCase();
  return command && nativeCommandNames.has(command) ? (command as NativeSlashCommand) : null;
}

export function isNativeSlashCommand(command: string): command is NativeSlashCommand {
  return nativeCommandNames.has(command.toLowerCase());
}

export function isPiManagementCommand(command: NativeSlashCommand): command is PiManagementCommand {
  return managementCommandNames.has(command);
}

export function resolveNativeSlashCommandDispatch(
  command: NativeSlashCommand,
  isLocalDraftThread: boolean,
):
  | { readonly type: "notice"; readonly message: string }
  | { readonly type: "dialog"; readonly command: NativeSlashCommand } {
  return command === "tree" && isLocalDraftThread
    ? { type: "notice", message: "No entries in session" }
    : { type: "dialog", command };
}
