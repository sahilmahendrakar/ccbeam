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
 *   - Restoring the terminal no matter how we leave. A relay that throws with
 *     the tty still in raw mode leaves the user's shell unusable.
 */

const LAUNCH = "/tmp/beamup-launch.sh";

/**
 * Run a bash script in the sandbox with the user's terminal attached.
 * Resolves with its exit code.
 */
export async function relay(sandbox, script, { timeoutMs, envs = {} } = {}) {
  const size = () => ({
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  });

  await sandbox.files.write(LAUNCH, script);

  const handle = await sandbox.pty.create({
    ...size(),
    timeoutMs,
    envs,
    onData: (data) => process.stdout.write(data),
  });

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

    // Turn off the shell's echo before handing it the command, so the command
    // itself does not flash on screen before the TUI paints over it.
    send(new TextEncoder().encode(`stty -echo 2>/dev/null; exec bash ${LAUNCH}\n`));

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
