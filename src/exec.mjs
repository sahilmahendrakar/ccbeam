import { spawn } from "node:child_process";

/**
 * Claude Code marks its own subprocesses so nested sessions don't write
 * transcripts. ccteleport is a supervisor, not a nested agent — if we inherit
 * these, the session we launch silently stops saving and there is nothing to
 * teleport. Scrubbed from every child we start.
 */
const INHERITED_MARKERS = [
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_PID",
];

export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of INHERITED_MARKERS) delete env[k];
  return { ...env, ...extra };
}

/** Run a command and capture its output. Never throws on a non-zero exit. */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, env: cleanEnv(opts.env), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Run a command attached to our terminal, returning its exit code. */
export function runInherit(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, env: cleanEnv(opts.env), stdio: "inherit" });
    child.on("error", () => resolve(-1));
    child.on("close", (code) => resolve(code ?? -1));
  });
}

/** Pipe one command's stdout into another's stdin (used for tar-over-ssh). */
export function pipeline(a, b) {
  return new Promise((resolve) => {
    const left = spawn(a.cmd, a.args, { env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
    const right = spawn(b.cmd, b.args, { env: cleanEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    left.stderr.on("data", (d) => (stderr += d));
    right.stderr.on("data", (d) => (stderr += d));
    left.stdout.pipe(right.stdin);
    left.on("error", (e) => (stderr += String(e)));
    right.on("error", (e) => (stderr += String(e)));
    right.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

/** Shell-quote a string for safe interpolation into a remote command. */
export function q(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
