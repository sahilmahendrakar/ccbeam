import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where Claude Code keeps its state. Machines differ — always ask, never assume. */
export function configDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

/**
 * Claude Code files every session under a slug of the absolute working
 * directory. Determined empirically, not documented: every character outside
 * [A-Za-z0-9] collapses to a dash, so `/tmp/cct.slug_test-x` becomes
 * `-tmp-cct-slug-test-x`.
 *
 * This is the one piece of Claude Code's internals ccteleport depends on. The
 * reverse mapping is deliberately never attempted: slugs are lossy (a dash in
 * the original path is indistinguishable from a separator), so anywhere we need
 * a real path we read the `cwd` field recorded inside the transcript instead.
 */
export function slug(dir) {
  return dir.replace(/[^a-zA-Z0-9]/g, "-");
}

export function projectDir(cfg, dir) {
  return path.join(cfg, "projects", slug(dir));
}

export function transcriptPath(cfg, dir, sessionId) {
  return path.join(projectDir(cfg, dir), `${sessionId}.jsonl`);
}

/** The session that most recently wrote in this directory, or null. */
export function newestSession(cfg, dir) {
  let best = null;
  try {
    const pd = projectDir(cfg, dir);
    for (const f of fs.readdirSync(pd)) {
      if (!f.endsWith(".jsonl")) continue;
      const { mtimeMs } = fs.statSync(path.join(pd, f));
      if (!best || mtimeMs > best.mtimeMs) best = { id: f.slice(0, -".jsonl".length), mtimeMs };
    }
  } catch {
    /* no sessions here yet */
  }
  return best?.id ?? null;
}

/** ccteleport's own state lives outside Claude Code's tree. */
export function stateDir() {
  return path.join(os.homedir(), ".ccteleport");
}

export function readState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir(), "state.json"), "utf8"));
  } catch {
    return { recents: [] };
  }
}

export function writeState(state) {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(path.join(stateDir(), "state.json"), JSON.stringify(state, null, 2));
}

/**
 * Remember where we've been, newest first. The picker's ordering and its
 * pre-selected folder both come from this.
 */
export function recordVisit(machine, dir) {
  const state = readState();
  state.recents = [
    { machine, dir, at: Date.now() },
    ...(state.recents ?? []).filter((r) => !(r.machine === machine && r.dir === dir)),
  ].slice(0, 100);
  writeState(state);
}

export function lastDirOn(machine) {
  return readState().recents?.find((r) => r.machine === machine)?.dir ?? null;
}
