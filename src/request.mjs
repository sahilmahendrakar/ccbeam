import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./paths.mjs";

/**
 * How the session tells the supervisor to move.
 *
 * A slash command cannot take over the terminal — tool output is captured, not
 * written to the tty — so `/beam` does not move anything itself. It drops a
 * request file; the plugin's Stop hook ends the session at the turn boundary
 * (so the transcript is complete on disk); the supervisor, which has been
 * waiting on the child all along, reads the file and performs the move.
 *
 * The path travels in BEAMUP_REQ so the plugin never has to guess which
 * session it belongs to.
 */
export function requestPath(env = process.env) {
  return env.BEAMUP_REQ || path.join(stateDir(), "request.json");
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
 * `/beam gpu-box:~/src`, `/beam gpu-box`, `/beam cloud`, `/beam home` and a
 * bare `/beam` are all valid; anything absent is chosen in the picker.
 *
 * `home` is reserved: it means the device and folder this session started in,
 * however many hops ago. A device you happen to have named `home` in your ssh
 * config is still reachable as `home:` with an explicit folder.
 */
export const HOME = "home";
export const RESUME = "resume";

export function parseTarget(text) {
  let arg = (text ?? "").trim();
  if (!arg) return { device: null, dir: null, home: false, resume: false };

  /**
   * `<device> resume` is a different act from `<device>`, and deliberately a
   * different verb. `/beam cloud` moves *this* conversation there, keeping its
   * session id — which is why context survives. `/beam cloud resume` picks up a
   * conversation already living there, abandoning the current one. Overloading
   * the first to sometimes mean the second would let `/beam` lose your place.
   */
  let resume = false;
  const trailing = arg.match(/\s+(\S+)$/);
  if (trailing && trailing[1].toLowerCase() === RESUME) {
    resume = true;
    arg = arg.slice(0, trailing.index).trim();
  }
  if (!arg) return { device: null, dir: null, home: false, resume };

  const i = arg.indexOf(":");
  if (i === -1) {
    if (arg.toLowerCase() === HOME) return { device: null, dir: null, home: true, resume: false };
    return { device: arg, dir: null, home: false, resume };
  }
  return { device: arg.slice(0, i) || null, dir: arg.slice(i + 1) || null, home: false, resume };
}
