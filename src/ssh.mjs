import fs from "node:fs";
import path from "node:path";
import { pipeline, q, run, runInherit } from "./exec.mjs";
import { stateDir } from "./paths.mjs";

/**
 * A beam makes several ssh calls in a row — probe the machine, list its
 * folders, check git state, ship the transcript, launch. Without connection
 * sharing each of those pays a full handshake (~300ms); with it, every call
 * after the first is ~10ms. This is what makes the picker feel instant.
 */
function controlArgs() {
  const dir = path.join(stateDir(), "cm");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return [
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${path.join(dir, "%C")}`,
    "-o", "ControlPersist=120",
  ];
}

export function sshArgs(host, extra = []) {
  return [...controlArgs(), ...extra, host];
}

/** Run a shell snippet on the remote machine and capture its output. */
export function sshExec(host, script, { timeout = 20000 } = {}) {
  const args = sshArgs(host, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8"]);
  return run("ssh", [...args, `bash -c ${q(script)}`], { timeout });
}

/**
 * Attach the user's terminal to a command on the remote machine. `-t` forces a
 * PTY, which is what lets the real Claude Code TUI render locally with no
 * relaying on our part.
 */
export function sshInteractive(host, script) {
  return runInherit("ssh", ["-t", ...sshArgs(host), `bash -lc ${q(script)}`]);
}

/** What we need to know about a machine before beaming to it. */
export async function probe(host) {
  const script = [
    'echo "home=$HOME"',
    'echo "cfg=${CLAUDE_CONFIG_DIR:-$HOME/.claude}"',
    'echo "claude=$(command -v claude || true)"',
    'echo "node=$(command -v node || true)"',
    'echo "git=$(command -v git || true)"',
    'echo "tmux=$(command -v tmux || true)"',
    'echo "version=$(claude --version 2>/dev/null | head -1 || true)"',
  ].join("; ");
  const r = await sshExec(host, script, { timeout: 20000 });
  if (r.code !== 0) {
    return { ok: false, error: (r.stderr || "unreachable").trim().split("\n").pop() };
  }
  const info = { ok: true };
  for (const line of r.stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) info[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return info;
}

/** Is this machine reachable right now? Used for the picker's status dots. */
export async function isOnline(host) {
  const args = sshArgs(host, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=4"]);
  const r = await run("ssh", [...args, "true"], { timeout: 6000 });
  return r.code === 0;
}

/** Copy a directory's contents to the remote machine, creating it if needed. */
export async function pushDir(host, localDir, remoteDir) {
  const mk = await sshExec(host, `mkdir -p ${q(remoteDir)}`);
  if (mk.code !== 0) return { code: mk.code, stderr: mk.stderr };
  return pipeline(
    { cmd: "tar", args: ["czf", "-", "-C", localDir, "."] },
    { cmd: "ssh", args: [...sshArgs(host), `tar xzf - -C ${q(remoteDir)}`] },
  );
}

/** Copy a directory's contents back from the remote machine. */
export async function pullDir(host, remoteDir, localDir) {
  fs.mkdirSync(localDir, { recursive: true });
  return pipeline(
    { cmd: "ssh", args: [...sshArgs(host), `tar czf - -C ${q(remoteDir)} . 2>/dev/null`] },
    { cmd: "tar", args: ["xzf", "-", "-C", localDir] },
  );
}

export async function readRemoteFile(host, file) {
  const r = await sshExec(host, `cat ${q(file)} 2>/dev/null || true`);
  return r.stdout.trim() || null;
}

export async function removeRemoteFile(host, file) {
  await sshExec(host, `rm -f ${q(file)}`);
}
