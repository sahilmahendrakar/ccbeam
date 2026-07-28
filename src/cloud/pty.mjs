/**
 * Wiring your terminal to a program inside the sandbox.
 *
 * Over ssh this file would not exist: `ssh -t` hands the tty to the far side
 * and the kernel does the rest. A sandbox has no tty to hand over, so we relay
 * — raw bytes from stdin into the sandbox's PTY, PTY output back to stdout, and
 * window-size changes forwarded so the Claude Code TUI knows how big it is.
 *
 * Three details are load-bearing:
 *
 *   - Raw mode. Without it the terminal line-buffers and interprets ^C itself,
 *     so the TUI would receive nothing until you pressed enter and Ctrl-C would
 *     kill the supervisor instead of reaching Claude Code.
 *   - `exec`. E2B's PTY always starts a shell, with no way to hand it a command,
 *     so we feed it one. `exec` *replaces* that shell, which is what makes the
 *     PTY close when Claude Code exits rather than dropping you at a prompt in
 *     a sandbox you did not ask for.
 *   - Swallowing the launch. That shell prints a prompt and the tty echoes the
 *     command as its bytes arrive — both before anything of ours can run, so
 *     `stty -echo` is already too late. Instead nothing is forwarded to the
 *     real terminal until the launch script says it is running. The user sees
 *     their session, never the plumbing that started it.
 *   - Restoring the terminal no matter how we leave. A relay that throws with
 *     the tty still in raw mode leaves the user's shell unusable.
 */

/**
 * Printed by the launch script, never forwarded. It lives inside the script
 * rather than on the command line, so the tty's echo of `exec bash <path>`
 * cannot contain it — which is what makes it a reliable gate.
 */
const READY = "__ccbeam_ready__";

/**
 * Run a bash script in the sandbox with the user's terminal attached.
 * Resolves with its exit code.
 */
export async function relay(sandbox, script, { timeoutMs, envs = {}, launchFile } = {}) {
  const size = () => ({
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  });

  // Not /tmp: it is sticky, and the file API cannot overwrite an existing file
  // there, so the second beam of the session would fail where the first
  // succeeded. Everything we write to the box lives under its own ~/.ccbeam.
  await sandbox.files.write(launchFile, `printf %s ${JSON.stringify(READY)}\n${script}`);

  // Everything up to and including the readiness marker is the shell starting
  // up, and belongs to us rather than to the user's screen.
  let live = false;
  let pending = "";
  const onData = (data) => {
    if (live) return process.stdout.write(data);
    pending += Buffer.from(data).toString("utf8");
    const at = pending.indexOf(READY);
    if (at === -1) {
      // Keep only enough to catch a marker split across two chunks.
      if (pending.length > READY.length * 2) pending = pending.slice(-READY.length);
      return;
    }
    live = true;
    const rest = pending.slice(at + READY.length);
    pending = "";
    if (rest) process.stdout.write(rest);
  };

  const handle = await sandbox.pty.create({ ...size(), timeoutMs, envs, onData });

  const send = (data) => {
    // Deliberately not awaited: awaiting each keystroke would serialise typing
    // behind a round trip. Errors here mean the PTY is gone, which the wait()
    // below is already about to tell us.
    sandbox.pty.sendInput(handle.pid, data).catch(() => {});
  };

  const onStdin = (buf) => send(new Uint8Array(buf));
  const onResize = () => {
    sandbox.pty.resize(handle.pid, size()).catch(() => {});
  };

  /**
   * While the far side owns the terminal, ^C is its business, not ours. In raw
   * mode the bytes reach the PTY directly, but the supervisor also installs a
   * SIGINT handler that shuts the box down — and that one would fire on a
   * Ctrl-C meant for Claude Code, ending the session instead of interrupting a
   * turn. So its listeners step aside for the duration and are put back after.
   */
  const outerInterrupts = process.listeners("SIGINT");
  const onInterrupt = () => {};

  const wasRaw = process.stdin.isRaw;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    process.stdin.off("data", onStdin);
    process.stdout.off("resize", onResize);
    process.off("SIGINT", onInterrupt);
    for (const listener of outerInterrupts) process.on("SIGINT", listener);
    if (process.stdin.isTTY) process.stdin.setRawMode(Boolean(wasRaw));
    process.stdin.pause();
  };

  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onStdin);
    process.stdout.on("resize", onResize);
    for (const listener of outerInterrupts) process.off("SIGINT", listener);
    process.on("SIGINT", onInterrupt);

    send(new TextEncoder().encode(`exec bash ${launchFile}\n`));

    const result = await handle.wait();
    return result?.exitCode ?? 0;
  } catch (err) {
    // A PTY that exits non-zero surfaces as an error in the SDK; that is an
    // outcome, not a failure of the relay.
    if (typeof err?.exitCode === "number") return err.exitCode;
    throw err;
  } finally {
    restore();
    await sandbox.pty.kill(handle.pid).catch(() => {});
  }
}
