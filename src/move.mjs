import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { q, run } from "./exec.mjs";
import { applyBundle, captureBundle, describeRefusal, fingerprint, isRepo } from "./carry.mjs";
import { configDir, projectDir, slug, stateDir } from "./paths.mjs";
import { seedRepo } from "./seed.mjs";
import { note, warn } from "./ui.mjs";

const PKG_ROOT = path.resolve(new URL("..", import.meta.url).pathname);

export const localPluginDir = () => path.join(PKG_ROOT, "plugin");
export const remoteRuntime = (home) => `${home}/.ccbeam/runtime`;
export const remotePlugin = (home) => `${remoteRuntime(home)}/plugin`;
export const remoteRequestFile = (home) => `${home}/.ccbeam/request.json`;

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ccbeam-${tag}-`));
}

/**
 * Everything the far side needs to run: the plugin Claude Code loads, and the
 * helper that applies a carried bundle. Shipped on every beam so the two
 * devices can never drift to incompatible versions.
 */
export async function pushRuntime(device, home) {
  const stage = tmpDir("runtime");
  for (const dir of ["plugin", "src", "scripts"]) {
    await run("cp", ["-a", path.join(PKG_ROOT, dir), stage]);
  }
  await run("cp", ["-a", path.join(PKG_ROOT, "package.json"), stage]);
  const res = await device.pushDir(stage, remoteRuntime(home));
  fs.rmSync(stage, { recursive: true, force: true });
  return res;
}

/** Stage just this session's files — never the whole project directory. */
function stageSession(cfg, dir, sessionId) {
  const src = projectDir(cfg, dir);
  const stage = tmpDir("session");
  const transcript = path.join(src, `${sessionId}.jsonl`);
  if (fs.existsSync(transcript)) fs.copyFileSync(transcript, path.join(stage, `${sessionId}.jsonl`));
  const sidecar = path.join(src, `${sessionId}.ccr-tip.json`);
  if (fs.existsSync(sidecar)) fs.copyFileSync(sidecar, path.join(stage, `${sessionId}.ccr-tip.json`));
  const memory = path.join(src, "memory");
  if (fs.existsSync(memory)) fs.cpSync(memory, path.join(stage, "memory"), { recursive: true });
  return stage;
}

export async function checkDevice(device) {
  const info = await device.probe();
  if (!info.ok) return { ok: false, error: info.error };

  const missing = [];
  if (!info.claude) missing.push("claude");
  if (!info.node) missing.push("node");
  if (!info.git) missing.push("git");
  return { ...info, missing };
}

export function describeMissing(device, missing) {
  const lines = [`${device.name} is missing: ${missing.join(", ")}`];
  if (missing.includes("claude")) {
    if (device.kind === "cloud") {
      lines.push("  the cloud box was not provisioned — run:  ccbeam cloud repair");
    } else {
      lines.push(`  install Claude Code there, then sign in:  ssh ${device.name} -t 'claude auth login'`);
    }
  }
  if (missing.includes("node")) lines.push("  ccbeam's plugin needs Node 18+ on that device");
  return lines.join("\n");
}

/**
 * Move a session from this machine to a directory on a device.
 * Returns the information the supervisor needs to launch there.
 */
export async function beamOut({ device, remoteDir, localDir, sessionId, carry = true }) {
  const up = await device.ensureUp();
  if (!up.ok) return { ok: false, error: up.error };
  if (up.note) note(up.note);

  const info = await checkDevice(device);
  if (!info.ok) return { ok: false, error: info.error };
  if (info.missing.length) return { ok: false, error: describeMissing(device, info.missing) };

  const localVersion = (await run("claude", ["--version"])).stdout.trim();
  if (info.version && localVersion && info.version !== localVersion) {
    warn(`version skew — local ${localVersion}, ${device.name} ${info.version}`);
  }

  const mk = await device.exec(`mkdir -p ${q(remoteDir)}`);
  if (mk.code !== 0) return { ok: false, error: `cannot create ${remoteDir} on ${device.name}` };

  await pushRuntime(device, info.home);

  // The transcript, which is what makes this the same conversation.
  const stage = stageSession(configDir(), localDir, sessionId);
  const dest = `${info.cfg}/projects/${slug(remoteDir)}`;
  const pushed = await device.pushDir(stage, dest);
  fs.rmSync(stage, { recursive: true, force: true });
  if (pushed.code !== 0) return { ok: false, error: `could not ship the transcript: ${pushed.stderr}` };

  const result = { ok: true, info, carried: null, departure: null };

  if (carry && (await isRepo(localDir))) {
    // A device you have beamed to before already has the repo. A fresh cloud
    // box does not, and a patch has nothing to apply against — so seed it from
    // *this* machine's history rather than from a git host, which keeps the
    // same-commit invariant intact and means the box never needs your GitHub
    // credentials (or your code to have been pushed anywhere at all).
    const seeded = await seedRepo({ device, localDir, remoteDir, home: info.home, onProgress: note });
    if (seeded.seeded) note(`seeded ${path.basename(remoteDir)} @ ${seeded.head.slice(0, 7)}`);
    if (seeded.error) {
      result.carryRefused = seeded.error;
      return result;
    }

    const bundleDir = tmpDir("carry");
    const captured = await captureBundle(localDir, bundleDir);
    if (captured.ok && !captured.empty) {
      const remoteBundle = `${info.home}/.ccbeam/carry`;
      await device.exec(`rm -rf ${q(remoteBundle)}`);
      const sent = await device.pushDir(bundleDir, remoteBundle);
      if (sent.code === 0) {
        const applied = await device.exec(
          `cd ${q(remoteDir)} && node ${q(`${remoteRuntime(info.home)}/scripts/carry-apply.mjs`)} ${q(remoteDir)} ${q(remoteBundle)}`,
          { timeout: 60000 },
        );
        const parsed = parseApply(applied.stdout);
        if (parsed?.ok) {
          result.carried = { files: captured.files, direction: "out" };
          result.departure = { untracked: captured.untracked, fingerprint: await fingerprint(localDir) };
        } else {
          result.carryRefused = parsed ? describeRefusal(parsed) : applied.stderr.trim() || "unknown error";
        }
      }
    }
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }

  return result;
}

/**
 * Go to a device and pick up a conversation that already lives there.
 *
 * The opposite of beamOut in the one way that matters: nothing travels. No
 * transcript is shipped (theirs is the one we want), no repo is seeded (it is
 * already there, or the session would not exist), and no uncommitted work is
 * carried — the current repo's diff has no business in another conversation's
 * folder. All this does is make sure the device can run the session.
 */
export async function beamAdopt({ device, sessionId, remoteDir }) {
  const up = await device.ensureUp({ onProgress: note });
  if (!up.ok) return { ok: false, error: up.error };
  if (up.note) note(up.note);

  const info = await checkDevice(device);
  if (!info.ok) return { ok: false, error: info.error };
  if (info.missing.length) return { ok: false, error: describeMissing(device, info.missing) };

  const present = await device.exec(
    `CFG="$CLAUDE_CONFIG_DIR"; [ -n "$CFG" ] || CFG="$HOME/.claude"; ` +
      `ls "$CFG"/projects/*/${q(sessionId)}.jsonl >/dev/null 2>&1 && echo yes || echo no`,
  );
  if (present.stdout.trim() !== "yes") {
    return { ok: false, error: `session ${sessionId} is no longer on ${device.name}` };
  }

  const pushed = await pushRuntime(device, info.home);
  if (pushed.code !== 0) return { ok: false, error: `could not ship the plugin: ${pushed.stderr}` };

  return { ok: true, info, dir: remoteDir };
}

/** Bring the session — and any work done out there — back to this machine. */
export async function beamBack({ device, remoteDir, localDir, sessionId, home, cfg, departure }) {
  const stage = tmpDir("return");
  const src = `${cfg}/projects/${slug(remoteDir)}`;
  const remoteStage = `${home}/.ccbeam/return`;

  // Stage exactly this session's files on the far side, then pull that. Doing
  // the selection over there keeps the transfer transport-neutral — it is the
  // same two calls whether the bytes travel over ssh or a sandbox socket.
  const staged = await device.exec(
    [
      `rm -rf ${q(remoteStage)}`,
      `mkdir -p ${q(remoteStage)}`,
      `cp -a ${q(`${src}/${sessionId}.jsonl`)} ${q(remoteStage)}/ 2>/dev/null || true`,
      `cp -a ${q(`${src}/${sessionId}.ccr-tip.json`)} ${q(remoteStage)}/ 2>/dev/null || true`,
      `[ -d ${q(`${src}/memory`)} ] && cp -a ${q(`${src}/memory`)} ${q(remoteStage)}/ || true`,
    ].join("; "),
  );

  const pulled = staged.code === 0 ? await device.pullDir(remoteStage, stage) : staged;
  await device.exec(`rm -rf ${q(remoteStage)}`);

  const result = { ok: pulled.code === 0, carried: null };

  if (result.ok) {
    const destProject = projectDir(configDir(), localDir);
    fs.mkdirSync(destProject, { recursive: true });
    for (const entry of fs.readdirSync(stage)) {
      const from = path.join(stage, entry);
      const to = path.join(destProject, entry);
      fs.cpSync(from, to, { recursive: true, force: true });
    }
  } else {
    result.error = (pulled.stderr ?? "").trim() || "could not retrieve the transcript";
  }
  fs.rmSync(stage, { recursive: true, force: true });

  // Work done out there comes home too.
  if (await isRepo(localDir)) {
    const remoteBundle = `${home}/.ccbeam/carry-back`;
    const capture = await device.exec(
      `node ${q(`${remoteRuntime(home)}/scripts/carry-capture.mjs`)} ${q(remoteDir)} ${q(remoteBundle)}`,
      { timeout: 60000 },
    );
    const summary = parseApply(capture.stdout);
    if (summary?.ok && !summary.empty) {
      const bundleDir = tmpDir("carry-back");
      const got = await device.pullDir(remoteBundle, bundleDir);
      if (got.code === 0) {
        const here = await fingerprint(localDir);
        if (departure?.fingerprint && here !== departure.fingerprint) {
          const keep = path.join(stateDir(), `incoming-${Date.now()}`);
          fs.cpSync(bundleDir, keep, { recursive: true });
          result.carryRefused = `this directory changed while you were away — the work from ${device.name} is saved at ${keep}`;
        } else {
          const applied = await applyBundle(localDir, bundleDir, { replacing: departure ?? { untracked: [] } });
          if (applied.ok) result.carried = { files: applied.files, direction: "back" };
          else {
            const keep = path.join(stateDir(), `incoming-${Date.now()}`);
            fs.cpSync(bundleDir, keep, { recursive: true });
            result.carryRefused = `${describeRefusal(applied)} — the work from ${device.name} is saved at ${keep}`;
          }
        }
      }
      fs.rmSync(bundleDir, { recursive: true, force: true });
    }
  }

  return result;
}

/** Moving between two directories on this machine is the same operation, minus a transport. */
export async function beamLocal({ fromDir, toDir, sessionId }) {
  const cfg = configDir();
  const stage = stageSession(cfg, fromDir, sessionId);
  const dest = projectDir(cfg, toDir);
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(stage)) {
    fs.cpSync(path.join(stage, entry), path.join(dest, entry), { recursive: true, force: true });
  }
  fs.rmSync(stage, { recursive: true, force: true });
  return { ok: true };
}

function parseApply(stdout) {
  const line = stdout.split("\n").find((l) => l.trim().startsWith("{"));
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export { note };
