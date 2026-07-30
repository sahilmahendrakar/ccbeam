/**
 * A sandbox you rent by the second.
 *
 * It is a device like any other: the supervisor sends it bash and copies
 * directories in and out, exactly as it does over ssh. What is different is
 * that it has a *lifecycle* — it can be asleep, it costs money while awake, and
 * it did not exist until you asked for it. That is what ensureUp/release are
 * for, and why they are no-ops on an ssh box.
 *
 * Two rules this file exists to keep:
 *
 *   - It runs on **your** E2B account. ccbeam operates no infrastructure, holds
 *     no key and proxies nothing. Your code goes from your machine to your
 *     sandbox.
 *   - It cannot quietly run forever. Every sandbox is created with `autoPause`
 *     and a finite timeout, so even if ccbeam is killed -9 the box puts itself
 *     to sleep instead of billing you until you notice.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../exec.mjs";
import { relay } from "../cloud/pty.mjs";
import { BACKSTOP_MS, apiKey, patchCloud, readCloud } from "../cloud/config.mjs";
import { PACKAGE, ensureE2B } from "../cloud/sdk.mjs";
import { DEFAULT_PRUNE_DAYS, pruneSessions } from "../cloud/sessions.mjs";

export const CLOUD_USER = "user";
export const CLOUD_HOME = `/home/${CLOUD_USER}`;

/**
 * Claude Code is installed into the user's own npm prefix (no sudo needed, so
 * it works whatever the image's permissions are). Non-interactive commands do
 * not always source .bashrc, so every script we send says where to look rather
 * than hoping.
 */
const PATH_PRELUDE = 'export PATH="$HOME/.npm-global/bin:$PATH"; [ -f "$HOME/.ccbeam/env" ] && . "$HOME/.ccbeam/env";';

/**
 * Scratch space inside the box.
 *
 * Deliberately not /tmp: it is sticky, and E2B's file API cannot overwrite an
 * existing file there — the first write of a session succeeds and every one
 * after it fails with EACCES. Under the box's own home there is no such trap.
 */
const SCRATCH = `${CLOUD_HOME}/.ccbeam/tmp`;
const LAUNCH_FILE = `${CLOUD_HOME}/.ccbeam/launch.sh`;

function tmpFile(tag) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `ccbeam-${tag}-`)), "bundle.tar.gz");
}

/**
 * How to make a box that puts itself to sleep — the invariant this whole file
 * exists to keep.
 *
 * When the backstop expires the box must *pause*, not die: a supervisor that
 * gets killed should cost you nothing and lose you nothing. Which option says
 * so changed shape mid-2.x. It was the beta flag `autoPause` up to 2.29, and is
 * `lifecycle.onTimeout` from 2.20 on, where the default is `kill`. Both eras
 * also ship a plain `create` that silently ignores an option it doesn't know —
 * so getting this wrong raises nothing, creates the box happily, and simply
 * loses it hours later along with its Claude Code sign-in.
 *
 * So: pick by capability rather than by version number, and on a major nobody
 * has tested, refuse instead of guessing. A cloud box you can't make is a bad
 * afternoon; a cloud box that quietly never pauses is a bill and a lost login.
 */
export function pauseOnTimeoutCreate(Sandbox, version) {
  if (typeof Sandbox?.betaCreate === "function") {
    return { ok: true, call: (template, opts) => Sandbox.betaCreate(template, { ...opts, autoPause: true }) };
  }
  if (version && !/^2\./.test(version)) {
    return {
      ok: false,
      error:
        `the installed ${PACKAGE} SDK (${version}) is newer than ccbeam knows how to keep asleep — ` +
        `refusing to create a box that might never pause. Please open an issue.`,
    };
  }
  if (typeof Sandbox?.create !== "function") {
    return { ok: false, error: `the installed ${PACKAGE} SDK (${version ?? "unknown"}) has no usable create()` };
  }
  return {
    ok: true,
    call: (template, opts) => Sandbox.create(template, { ...opts, lifecycle: { onTimeout: "pause" } }),
  };
}

export class E2BDevice {
  /** Pruning is a per-process housekeeping chore, not a per-connection one. */
  static pruned = false;

  constructor() {
    this.name = "cloud";
    this.kind = "cloud";
    this.sandbox = null;
  }

  /** The SDK, fetched on first use. */
  async sdk({ onProgress } = {}) {
    if (this._sdk) return { ok: true, e2b: this._sdk, version: this._sdkVersion };
    const loaded = await ensureE2B({ onProgress });
    if (loaded.ok) {
      this._sdk = loaded.e2b;
      this._sdkVersion = loaded.version;
    }
    return loaded;
  }

  /**
   * Wake the box, creating one if we have never made it. Resuming a paused
   * sandbox restores its filesystem *and* memory, which is why the box stays
   * signed in to Claude Code and keeps whatever you installed last week.
   */
  async ensureUp({ onProgress = () => {} } = {}) {
    if (this.sandbox) return { ok: true };

    const key = apiKey();
    if (!key) return { ok: false, error: "no E2B key yet — run `ccbeam cloud` to set the cloud box up" };

    const loaded = await this.sdk({ onProgress });
    if (!loaded.ok) return { ok: false, error: loaded.error };
    const { Sandbox } = loaded.e2b;

    const stored = readCloud();
    if (stored?.sandboxId) {
      try {
        this.sandbox = await Sandbox.connect(stored.sandboxId, { apiKey: key, timeoutMs: BACKSTOP_MS });
        patchCloud({ lastSeen: Date.now() });
        await this.prune({ onProgress });
        return { ok: true };
      } catch (err) {
        // Killed from the E2B dashboard, or expired past recovery. Say so
        // rather than silently building a new box the user didn't ask for —
        // everything installed on the old one is gone with it.
        return {
          ok: false,
          error: `the cloud box (${stored.sandboxId}) is no longer there — run \`ccbeam cloud repair\` to make a new one. (${err?.message ?? err})`,
        };
      }
    }

    return { ok: false, error: "the cloud box is not set up yet — run `ccbeam cloud`" };
  }

  /** Create a brand-new sandbox. Only the setup flow calls this. */
  async create({ template, onProgress = () => {} }) {
    const key = apiKey();
    if (!key) return { ok: false, error: "no E2B key" };
    const loaded = await this.sdk({ onProgress });
    if (!loaded.ok) return { ok: false, error: loaded.error };
    const { Sandbox } = loaded.e2b;

    const chosen = pauseOnTimeoutCreate(Sandbox, loaded.version);
    if (!chosen.ok) return chosen;

    try {
      this.sandbox = await chosen.call(template, {
        apiKey: key,
        timeoutMs: BACKSTOP_MS,
        metadata: { managedBy: "ccbeam" },
      });
    } catch (err) {
      return { ok: false, error: describeE2BError(err) };
    }

    patchCloud({ sandboxId: this.sandbox.sandboxId, template, createdAt: Date.now(), lastSeen: Date.now() });
    return { ok: true, sandboxId: this.sandbox.sandboxId };
  }

  /**
   * Drop conversations nobody has opened in a long time.
   *
   * Once per process, on connect. A cloud box otherwise accumulates every
   * session you ever took there, and an unbounded list is its own mess — but
   * this deletes history, so it says so out loud rather than tidying silently.
   */
  async prune({ onProgress = () => {} } = {}) {
    if (E2BDevice.pruned) return;
    E2BDevice.pruned = true;
    const days = readCloud()?.pruneDays ?? DEFAULT_PRUNE_DAYS;
    const { pruned } = await pruneSessions(this, { days }).catch(() => ({ pruned: 0 }));
    if (pruned) onProgress(`pruned ${pruned} conversation(s) untouched for ${days}+ days`);
  }

  async state() {
    const key = apiKey();
    const stored = readCloud();
    if (!key || !stored?.sandboxId) return null;
    const loaded = await this.sdk();
    if (!loaded.ok) return null;
    try {
      const info = await loaded.e2b.Sandbox.getInfo(stored.sandboxId, { apiKey: key });
      return info.state; // "running" | "paused"
    } catch {
      return null;
    }
  }

  async isOnline() {
    const state = await this.state();
    return state === "running" || state === "paused"; // paused still means reachable in ~1s
  }

  async probe() {
    const script = [
      'echo "home=$HOME"',
      'echo "cfg=${CLAUDE_CONFIG_DIR:-$HOME/.claude}"',
      'echo "claude=$(command -v claude || true)"',
      'echo "node=$(command -v node || true)"',
      'echo "git=$(command -v git || true)"',
      'echo "version=$(claude --version 2>/dev/null | head -1 || true)"',
    ].join("; ");
    const r = await this.exec(script, { timeout: 30000 });
    if (r.code !== 0) return { ok: false, error: (r.stderr || "the cloud box did not answer").trim().split("\n").pop() };
    const info = { ok: true };
    for (const line of r.stdout.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) info[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    return info;
  }

  /** Run bash and capture it. Never throws — a non-zero exit is a result. */
  async exec(script, { timeout = 20000 } = {}) {
    if (!this.sandbox) return { code: -1, stdout: "", stderr: "the cloud box is not connected" };
    try {
      const r = await this.sandbox.commands.run(`${PATH_PRELUDE} ${script}`, {
        timeoutMs: timeout,
        user: CLOUD_USER,
      });
      return { code: r.exitCode ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    } catch (err) {
      if (typeof err?.exitCode === "number") {
        return { code: err.exitCode, stdout: err.stdout ?? "", stderr: err.stderr ?? String(err.message ?? err) };
      }
      return { code: -1, stdout: "", stderr: String(err?.message ?? err) };
    }
  }

  attach(script) {
    if (!this.sandbox) return Promise.resolve(-1);
    return relay(this.sandbox, `${PATH_PRELUDE}\n${script}\n`, {
      timeoutMs: BACKSTOP_MS,
      launchFile: LAUNCH_FILE,
    });
  }

  /**
   * Directory transfer, tarred both ways.
   *
   * Same shape as the ssh path's tar-over-ssh, for the same reason: it
   * preserves modes and symlinks and it is one round trip rather than one per
   * file. The tarball goes through a temp file on each side because the SDK's
   * file API wants bytes in hand, not a stream.
   */
  async pushDir(localDir, remoteDir) {
    if (!this.sandbox) return { code: -1, stderr: "the cloud box is not connected" };
    const local = tmpFile("push");
    const remote = `${SCRATCH}/push.tar.gz`;
    try {
      const tarred = await run("tar", ["czf", local, "-C", localDir, "."]);
      if (tarred.code !== 0) return { code: tarred.code, stderr: tarred.stderr };
      await this.exec(`mkdir -p ${shq(SCRATCH)} && rm -f ${shq(remote)}`);

      const data = fs.readFileSync(local);
      await this.sandbox.files.write(
        remote,
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      );
      const unpacked = await this.exec(
        `mkdir -p ${shq(remoteDir)} && tar xzf ${shq(remote)} -C ${shq(remoteDir)} && rm -f ${shq(remote)}`,
        { timeout: 120000 },
      );
      return { code: unpacked.code, stderr: unpacked.stderr };
    } catch (err) {
      return { code: -1, stderr: String(err?.message ?? err) };
    } finally {
      fs.rmSync(path.dirname(local), { recursive: true, force: true });
    }
  }

  async pullDir(remoteDir, localDir) {
    if (!this.sandbox) return { code: -1, stderr: "the cloud box is not connected" };
    const local = tmpFile("pull");
    const remote = `${SCRATCH}/pull.tar.gz`;
    try {
      const packed = await this.exec(
        `mkdir -p ${shq(SCRATCH)} && tar czf ${shq(remote)} -C ${shq(remoteDir)} .`,
        { timeout: 120000 },
      );
      if (packed.code !== 0) return { code: packed.code, stderr: packed.stderr };

      const bytes = await this.sandbox.files.read(remote, { format: "bytes" });
      await this.exec(`rm -f ${shq(remote)}`);
      fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(local, Buffer.from(bytes));
      const unpacked = await run("tar", ["xzf", local, "-C", localDir]);
      return { code: unpacked.code, stderr: unpacked.stderr };
    } catch (err) {
      return { code: -1, stderr: String(err?.message ?? err) };
    } finally {
      fs.rmSync(path.dirname(local), { recursive: true, force: true });
    }
  }

  /**
   * We're leaving. Pause immediately rather than after a grace period: a box
   * that resumes in about a second does not need one, and "it stopped costing
   * money the moment you left" is a promise worth more than a fast second hop.
   */
  /**
   * We're leaving. Pause immediately rather than after a grace period: a box
   * that resumes in about a second does not need one, and "it stopped costing
   * money the moment you left" is a promise worth more than a fast second hop.
   *
   * Paused via the static management call with the key passed explicitly. The
   * instance method exists, but on e2b 2.2.1 it reaches the API with no
   * authorization header and fails — which would leave the box running, so
   * this is not a place to trust a convenience wrapper.
   */
  async release() {
    const sandbox = this.sandbox;
    this.sandbox = null;
    if (!sandbox) return null;

    const key = apiKey();
    const loaded = await this.sdk();
    if (!loaded.ok) return { warn: `could not pause the cloud box: ${loaded.error}` };

    try {
      // `betaPause` graduated to `pause`; both are present today, and taking
      // the stable name first means the beta one can disappear without this
      // being the thing that breaks.
      const { Sandbox } = loaded.e2b;
      const pause = typeof Sandbox.pause === "function" ? Sandbox.pause : Sandbox.betaPause;
      await pause.call(Sandbox, sandbox.sandboxId, { apiKey: key });
    } catch (err) {
      return {
        warn: `could not pause the cloud box: ${err?.message ?? err}. It will pause itself within the hour.`,
      };
    }

    // Trust the API's own view rather than the absence of an exception; this is
    // the one call whose silent failure costs the user money.
    try {
      const info = await loaded.e2b.Sandbox.getInfo(sandbox.sandboxId, { apiKey: key });
      if (info.state !== "paused") {
        return { warn: `the cloud box reports "${info.state}" after pausing — check https://e2b.dev/dashboard` };
      }
    } catch {
      /* the pause itself succeeded; a failed read-back is not worth alarming over */
    }

    patchCloud({ lastSeen: Date.now() });
    return { note: "cloud paused — billing stopped" };
  }

  async dispose() {
    this.sandbox = null;
  }
}

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function describeE2BError(err) {
  const message = String(err?.message ?? err);
  if (/unauthor|authentication|api key/i.test(message)) {
    return "E2B rejected that key — check it at https://e2b.dev/dashboard, then run `ccbeam cloud key`";
  }
  if (/rate limit/i.test(message)) return "E2B is rate limiting this account right now — try again in a moment";
  return message;
}
