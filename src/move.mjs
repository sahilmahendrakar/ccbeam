import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { q, run } from "./exec.mjs";
import { applyBundle, captureBundle, describeRefusal, fingerprint, isRepo } from "./carry.mjs";
import { configDir, projectDir, slug, stateDir } from "./paths.mjs";
import { probe, pullDir, pushDir, sshExec } from "./ssh.mjs";
import { note, warn } from "./ui.mjs";

const PKG_ROOT = path.resolve(new URL("..", import.meta.url).pathname);

export const localPluginDir = () => path.join(PKG_ROOT, "plugin");
export const remoteRuntime = (home) => `${home}/.ccteleport/runtime`;
export const remotePlugin = (home) => `${remoteRuntime(home)}/plugin`;
export const remoteRequestFile = (home) => `${home}/.ccteleport/request.json`;

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ccteleport-${tag}-`));
}

/**
 * Everything the far side needs to run: the plugin Claude Code loads, and the
 * helper that applies a carried bundle. Shipped on every teleport so the two
 * machines can never drift to incompatible versions.
 */
export async function pushRuntime(host, home) {
  const stage = tmpDir("runtime");
  for (const dir of ["plugin", "src", "scripts"]) {
    await run("cp", ["-a", path.join(PKG_ROOT, dir), stage]);
  }
  await run("cp", ["-a", path.join(PKG_ROOT, "package.json"), stage]);
  const res = await pushDir(host, stage, remoteRuntime(home));
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

export async function checkMachine(host) {
  const info = await probe(host);
  if (!info.ok) return { ok: false, error: info.error };

  const missing = [];
  if (!info.claude) missing.push("claude");
  if (!info.node) missing.push("node");
  if (!info.git) missing.push("git");
  return { ...info, missing };
}

export function describeMissing(host, missing) {
  const lines = [`${host} is missing: ${missing.join(", ")}`];
  if (missing.includes("claude")) {
    lines.push(`  install Claude Code there, then sign in:  ssh ${host} -t 'claude auth login'`);
  }
  if (missing.includes("node")) lines.push("  ccteleport's plugin needs Node 18+ on that machine");
  return lines.join("\n");
}

/**
 * Move a session from this machine to a remote directory.
 * Returns the information the supervisor needs to launch there.
 */
export async function teleportOut({ host, remoteDir, localDir, sessionId, carry = true }) {
  const info = await checkMachine(host);
  if (!info.ok) return { ok: false, error: info.error };
  if (info.missing.length) return { ok: false, error: describeMissing(host, info.missing) };

  const localVersion = (await run("claude", ["--version"])).stdout.trim();
  if (info.version && localVersion && info.version !== localVersion) {
    warn(`version skew — local ${localVersion}, ${host} ${info.version}`);
  }

  const mk = await sshExec(host, `mkdir -p ${q(remoteDir)}`);
  if (mk.code !== 0) return { ok: false, error: `cannot create ${remoteDir} on ${host}` };

  await pushRuntime(host, info.home);

  // The transcript, which is what makes this the same conversation.
  const stage = stageSession(configDir(), localDir, sessionId);
  const dest = `${info.cfg}/projects/${slug(remoteDir)}`;
  const pushed = await pushDir(host, stage, dest);
  fs.rmSync(stage, { recursive: true, force: true });
  if (pushed.code !== 0) return { ok: false, error: `could not ship the transcript: ${pushed.stderr}` };

  const result = { ok: true, info, carried: null, departure: null };

  if (carry && (await isRepo(localDir))) {
    const bundleDir = tmpDir("carry");
    const captured = await captureBundle(localDir, bundleDir);
    if (captured.ok && !captured.empty) {
      const remoteBundle = `${info.home}/.ccteleport/carry`;
      await sshExec(host, `rm -rf ${q(remoteBundle)}`);
      const sent = await pushDir(host, bundleDir, remoteBundle);
      if (sent.code === 0) {
        const applied = await sshExec(
          host,
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

/** Bring the session — and any work done out there — back to this machine. */
export async function teleportBack({ host, remoteDir, localDir, sessionId, home, cfg, departure }) {
  const stage = tmpDir("return");
  const src = `${cfg}/projects/${slug(remoteDir)}`;
  const script = [
    `S=$(mktemp -d)`,
    `cp -a ${q(`${src}/${sessionId}.jsonl`)} "$S"/ 2>/dev/null || true`,
    `cp -a ${q(`${src}/${sessionId}.ccr-tip.json`)} "$S"/ 2>/dev/null || true`,
    `[ -d ${q(`${src}/memory`)} ] && cp -a ${q(`${src}/memory`)} "$S"/ || true`,
    `tar czf - -C "$S" .`,
    `rm -rf "$S"`,
  ].join("; ");

  const pulled = await run("bash", [
    "-c",
    `ssh -o ControlMaster=auto -o ControlPath=${q(path.join(stateDir(), "cm", "%C"))} -o ControlPersist=120 ${q(host)} ${q(`bash -c ${q(script)}`)} | tar xzf - -C ${q(stage)}`,
  ]);

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
    result.error = pulled.stderr.trim() || "could not retrieve the transcript";
  }
  fs.rmSync(stage, { recursive: true, force: true });

  // Work done out there comes home too.
  if (await isRepo(localDir)) {
    const remoteBundle = `${home}/.ccteleport/carry-back`;
    const capture = await sshExec(
      host,
      `node ${q(`${remoteRuntime(home)}/scripts/carry-capture.mjs`)} ${q(remoteDir)} ${q(remoteBundle)}`,
      { timeout: 60000 },
    );
    const summary = parseApply(capture.stdout);
    if (summary?.ok && !summary.empty) {
      const bundleDir = tmpDir("carry-back");
      const got = await pullDir(host, remoteBundle, bundleDir);
      if (got.code === 0) {
        const here = await fingerprint(localDir);
        if (departure?.fingerprint && here !== departure.fingerprint) {
          const keep = path.join(stateDir(), `incoming-${Date.now()}`);
          fs.cpSync(bundleDir, keep, { recursive: true });
          result.carryRefused = `this directory changed while you were away — the work from ${host} is saved at ${keep}`;
        } else {
          const applied = await applyBundle(localDir, bundleDir, { replacing: departure ?? { untracked: [] } });
          if (applied.ok) result.carried = { files: applied.files, direction: "back" };
          else {
            const keep = path.join(stateDir(), `incoming-${Date.now()}`);
            fs.cpSync(bundleDir, keep, { recursive: true });
            result.carryRefused = `${describeRefusal(applied)} — the work from ${host} is saved at ${keep}`;
          }
        }
      }
      fs.rmSync(bundleDir, { recursive: true, force: true });
    }
  }

  return result;
}

/** Moving between two directories on this machine is the same operation, minus ssh. */
export async function teleportLocal({ fromDir, toDir, sessionId }) {
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
