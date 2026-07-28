import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./paths.mjs";

/**
 * How the session tells the supervisor to move.
 *
 * A slash command cannot take over the terminal — tool output is captured, not
 * written to the tty — so `/teleport` does not move anything itself. It drops a
 * request file; the plugin's Stop hook ends the session at the turn boundary
 * (so the transcript is complete on disk); the supervisor, which has been
 * waiting on the child all along, reads the file and performs the move.
 *
 * The path travels in CCTELEPORT_REQ so the plugin never has to guess which
 * session it belongs to.
 */
export function requestPath(env = process.env) {
  return env.CCTELEPORT_REQ || path.join(stateDir(), "request.json");
}

export function writeRequest(req, file = requestPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(req));
}

export function readRequest(file = requestPath()) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function clearRequest(file = requestPath()) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

/**
 * `/teleport gpu-box:~/src` and `/teleport gpu-box` and `/teleport` are all
 * valid; anything absent is chosen in the picker.
 */
export function parseTarget(text) {
  const arg = (text ?? "").trim();
  if (!arg) return { machine: null, dir: null };
  const i = arg.indexOf(":");
  if (i === -1) return { machine: arg, dir: null };
  return { machine: arg.slice(0, i) || null, dir: arg.slice(i + 1) || null };
}
