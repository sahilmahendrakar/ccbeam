/**
 * A Device is somewhere a session can sit.
 *
 * Everything above this interface — carrying uncommitted work, the picker, the
 * supervisor's move loop — is written against these methods and knows nothing
 * about how bytes actually get there. `SshDevice` is a machine you already have
 * an ssh config entry for; `E2BDevice` is a sandbox rented by the second. A
 * third (Fly, Modal, a plain VM with a start hook) only has to implement this
 * list; nothing else in the codebase should need to learn about it.
 *
 * The contract, in the order the supervisor calls them:
 *
 *   name                display name, and what the user types
 *   kind                "ssh" | "cloud"
 *   ensureUp()          make the device usable — may create, boot or resume.
 *                       -> { ok: true, note? } | { ok: false, error }
 *   probe()             what's installed over there.
 *                       -> { ok: true, home, cfg, claude, node, git, version }
 *                        | { ok: false, error }
 *   isOnline()          cheap reachability check for the picker's status dot
 *   exec(script, opts)  run a bash snippet, capture it -> { code, stdout, stderr }
 *   attach(script)      run a bash snippet with the user's terminal wired
 *                       straight to it -> exit code
 *   pushDir(from, to)   copy a local directory's contents over -> { code, stderr }
 *   pullDir(from, to)   copy a remote directory's contents back -> { code, stderr }
 *   release()           we're leaving. Stop costing money if you cost money.
 *                       -> { note? } | null
 *   dispose()           drop any connection. No lifecycle meaning; safe to call
 *                       more than once.
 *
 * `exec` and `attach` both receive plain bash. That is deliberate: both kinds of
 * device are Linux boxes, so the *commands* the supervisor builds are identical
 * and only the delivery differs. It is what keeps move.mjs transport-free.
 */
import { LOCAL, CLOUD } from "../devices.mjs";
import { SshDevice } from "./ssh.mjs";

/**
 * Resolve a device name to something that implements the interface above.
 * `local` never gets one — the supervisor handles this machine directly,
 * because there is no transport to abstract.
 */
export async function getDevice(name) {
  if (name === LOCAL) throw new Error("local is not a remote device");
  if (name === CLOUD) {
    // Loaded on demand so that installing beamup never pulls a cloud SDK for a
    // feature you have not asked for.
    const { E2BDevice } = await import("./e2b.mjs");
    return new E2BDevice();
  }
  return new SshDevice(name);
}
