import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Shell integration: make `claude` mean `ccbeam`.
 *
 * The supervisor has to own the terminal — a plugin cannot perform the swap,
 * because hooks and MCP servers die with the session they belong to. But it
 * does not have to be the command you type. A shell function shadows the
 * binary the same way nvm, pyenv and direnv do their work.
 *
 * Editing someone's dotfiles is rude without a clean way out, so everything
 * here is delimited, idempotent, and removable with one command.
 */

export const START = "# >>> ccbeam >>>";
export const END = "# <<< ccbeam <<<";

export const SHELLS = ["bash", "zsh", "fish"];

export function detectShell(env = process.env) {
  const shell = path.basename(env.SHELL || "");
  return SHELLS.includes(shell) ? shell : null;
}

export function rcFileFor(shell, env = process.env, home = os.homedir()) {
  switch (shell) {
    case "zsh":
      return path.join(env.ZDOTDIR || home, ".zshrc");
    case "fish":
      return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "fish", "config.fish");
    case "bash":
      // .bashrc is the one sourced by interactive non-login shells, which is
      // where an interactive tool belongs.
      return path.join(home, ".bashrc");
    default:
      return null;
  }
}

export function blockFor(shell) {
  const note = "# Makes `claude` beam-capable. Remove with: ccbeam uninstall-shell";
  if (shell === "fish") {
    return [START, note, "function claude", "    command ccbeam $argv", "end", END].join("\n");
  }
  // `command` so this function never calls itself.
  return [START, note, 'claude() { command ccbeam "$@"; }', END].join("\n");
}

export function isInstalled(text) {
  return text.includes(START);
}

/** Is something else already defining `claude`? Worth saying before we shadow it. */
export function conflictsIn(text) {
  const withoutOurs = stripBlock(text);
  return /^\s*(alias\s+claude=|claude\s*\(\s*\)|function\s+claude\b)/m.test(withoutOurs);
}

/**
 * Removes our block and exactly the whitespace we introduced around it —
 * the newline after it, and the blank separator line before it. Unrelated
 * blank lines in someone's rc file are theirs, not ours to normalise.
 */
function stripBlock(text) {
  const start = text.indexOf(START);
  if (start === -1) return text;
  const marker = text.indexOf(END, start);
  if (marker === -1) return text.slice(0, start);

  let end = marker + END.length;
  if (text[end] === "\n") end++;

  let begin = start;
  if (begin >= 2 && text[begin - 1] === "\n" && text[begin - 2] === "\n") begin--;

  return text.slice(0, begin) + text.slice(end);
}

export function install({ shell, rcFile }) {
  const file = rcFile || rcFileFor(shell);
  if (!file) return { ok: false, error: `unsupported shell: ${shell}` };

  const existed = fs.existsSync(file);
  const text = existed ? fs.readFileSync(file, "utf8") : "";
  if (isInstalled(text)) return { ok: true, action: "already", file };

  let backup = null;
  if (existed && text.trim()) {
    backup = `${file}.ccbeam.bak`;
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const separator = text.length && !text.endsWith("\n") ? "\n\n" : text.length ? "\n" : "";
  fs.writeFileSync(file, text + separator + blockFor(shell) + "\n");

  return { ok: true, action: "installed", file, backup, conflict: conflictsIn(text) };
}

export function uninstall({ shell, rcFile }) {
  const file = rcFile || rcFileFor(shell);
  if (!file) return { ok: false, error: `unsupported shell: ${shell}` };
  if (!fs.existsSync(file)) return { ok: true, action: "absent", file };

  const text = fs.readFileSync(file, "utf8");
  if (!isInstalled(text)) return { ok: true, action: "absent", file };

  fs.writeFileSync(file, stripBlock(text));
  return { ok: true, action: "removed", file };
}
