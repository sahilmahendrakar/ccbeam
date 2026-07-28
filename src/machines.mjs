import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readState } from "./paths.mjs";

export const LOCAL = "local";

/**
 * Machines come from the SSH config you already maintain, plus anywhere you
 * have actually teleported. There is no separate registry to keep in sync and
 * nothing to run on the far machine to "add" it — if you can ssh there, it is
 * already a destination.
 */
export function sshHosts() {
  const hosts = [];
  const seen = new Set();
  const files = [path.join(os.homedir(), ".ssh", "config")];

  while (files.length) {
    const file = files.shift();
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const [keyword, ...rest] = line.split(/\s+/);
      const key = keyword.toLowerCase();
      if (key === "include") {
        for (const pattern of rest) {
          const base = pattern.startsWith("~")
            ? path.join(os.homedir(), pattern.slice(1))
            : path.isAbsolute(pattern)
              ? pattern
              : path.join(os.homedir(), ".ssh", pattern);
          // Only literal includes; globbing SSH config is out of scope.
          if (!base.includes("*") && !seen.has(base)) files.push(base);
        }
      }
      if (key !== "host") continue;
      for (const name of rest) {
        // Patterns and negations are matchers, not destinations.
        if (name.includes("*") || name.includes("?") || name.startsWith("!")) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        hosts.push(name);
      }
    }
  }
  return hosts;
}

/**
 * The picker's first screen. `local` is always present and always first —
 * teleporting to your own machine is the same operation as any other, which is
 * what makes "move this conversation to another folder" fall out for free.
 */
export function machines(current = LOCAL) {
  const state = readState();
  const lastSeen = new Map();
  const counts = new Map();
  for (const r of state.recents ?? []) {
    if (!lastSeen.has(r.machine)) lastSeen.set(r.machine, r.at);
    counts.set(r.machine, (counts.get(r.machine) ?? 0) + 1);
  }

  const names = [LOCAL, ...new Set([...lastSeen.keys(), ...sshHosts()])].filter(
    (n, i, all) => all.indexOf(n) === i,
  );

  const rows = names.map((name) => ({
    name,
    isLocal: name === LOCAL,
    isCurrent: name === current,
    lastSeen: lastSeen.get(name) ?? 0,
    folders: counts.get(name) ?? 0,
    online: name === LOCAL ? true : null, // null = not probed yet
  }));

  rows.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
    if (a.lastSeen !== b.lastSeen) return b.lastSeen - a.lastSeen;
    return a.name.localeCompare(b.name);
  });
  return rows;
}
