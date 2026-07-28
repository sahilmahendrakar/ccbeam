/**
 * A machine you can ssh to.
 *
 * This is a thin wrapper over the ssh helpers, not a rewrite of them: `ssh -t`
 * hands the terminal to the far side with no relaying on our part, which is why
 * the Claude Code TUI renders perfectly over it, and connection sharing keeps
 * the repeated probe/list/push calls at ~10ms each. Nothing here needs to
 * change for a device to be usable, so ensureUp/release/dispose are no-ops —
 * an ssh host is always already "up" as far as we're concerned, and leaving one
 * costs nothing.
 */
import { isOnline, probe, pullDir, pushDir, sshExec, sshInteractive } from "../ssh.mjs";

export class SshDevice {
  constructor(name) {
    this.name = name;
    this.kind = "ssh";
  }

  async ensureUp() {
    return { ok: true };
  }

  probe() {
    return probe(this.name);
  }

  isOnline() {
    return isOnline(this.name);
  }

  exec(script, opts) {
    return sshExec(this.name, script, opts);
  }

  attach(script) {
    return sshInteractive(this.name, script);
  }

  pushDir(localDir, remoteDir) {
    return pushDir(this.name, localDir, remoteDir);
  }

  pullDir(remoteDir, localDir) {
    return pullDir(this.name, remoteDir, localDir);
  }

  async release() {
    return null;
  }

  async dispose() {}
}
