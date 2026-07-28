const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (code) => (s) => (useColor ? `[${code}m${s}[0m` : String(s));

export const dim = wrap("2");
export const bold = wrap("1");
export const cyan = wrap("36");
export const green = wrap("32");
export const yellow = wrap("33");
export const red = wrap("31");
export const inverse = wrap("7");

export function relTime(ms) {
  if (!ms) return "";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Shorten a path for display: /home/you/dev/x -> ~/dev/x */
export function tilde(p, home = process.env.HOME) {
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/**
 * The one thing the user must never be unsure about is which device they are
 * on — especially when one of them bills by the second. Say it loudly at every
 * transition.
 */
export function banner(device, dir, { local = false, cloud = false } = {}) {
  const mark = local ? "⌂" : cloud ? "☁" : "⚡";
  const where = local ? `local:${tilde(dir)}` : `${device}:${tilde(dir)}`;
  const hint = local ? "" : dim("  ·  /ccbeam:up home to return");
  process.stdout.write(`\n${cyan(bold(` ${mark} ${where}`))}${hint}\n\n`);
}

export function note(msg) {
  process.stdout.write(`${dim("  ·")} ${msg}\n`);
}

export function warn(msg) {
  process.stdout.write(`${yellow("  !")} ${msg}\n`);
}

export function fail(msg) {
  process.stdout.write(`${red("  ✕")} ${msg}\n`);
}
