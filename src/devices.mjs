import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCloud } from "./cloud/config.mjs";
import { readState } from "./paths.mjs";

export const LOCAL = "local";
export const CLOUD = "cloud";

/**
 * Devices come from the SSH config you already maintain, plus anywhere you have
 * actually beamed. There is no separate registry to keep in sync and nothing to
 * run on the far machine to "add" it — if you can ssh there, it is already a
 * destination.
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
        // `local` and `cloud` are ours; an ssh entry must not shadow them.
        if (name === LOCAL || name === CLOUD) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        hosts.push(name);
      }
    }
  }
  return hosts;
}

/**
 * The picker's first screen.
 *
 * `local` is always first — beaming to your own machine is the same operation
 * as any other, which is what makes "move this conversation to another folder"
 * fall out for free. `cloud` is always last and always present, set up or not,
 * because a device you have to read the README to discover may as well not
 * exist.
 */
export function devices(current = LOCAL, { cloudState = null } = {}) {
  const state = readState();
  const lastSeen = new Map();
  const counts = new Map();
  for (const r of state.recents ?? []) {
    if (!lastSeen.has(r.device)) lastSeen.set(r.device, r.at);
    counts.set(r.device, (counts.get(r.device) ?? 0) + 1);
  }

  const remote = [...new Set([...lastSeen.keys(), ...sshHosts()])].filter(
    (n) => n !== LOCAL && n !== CLOUD,
  );

  const rows = [LOCAL, ...remote].map((name) => ({
    name,
    kind: name === LOCAL ? "local" : "ssh",
    isLocal: name === LOCAL,
    isCloud: false,
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

  const cloud = readCloud();
  rows.push({
    name: CLOUD,
    kind: "cloud",
    isLocal: false,
    isCloud: true,
    isCurrent: current === CLOUD,
    lastSeen: lastSeen.get(CLOUD) ?? 0,
    folders: counts.get(CLOUD) ?? 0,
    online: null,
    configured: Boolean(cloud?.sandboxId),
    state: cloud?.sandboxId ? cloudState : null, // "running" | "paused" | null if unasked
  });

  return rows;
}

/**
 * Where a repo lands the first time it reaches the cloud box.
 *
 * A fresh sandbox has no history to offer a folder picker and exactly one
 * sensible answer — the repo you are standing in — so ccbeam answers for you.
 */
export function cloudWorkDir(localDir) {
  return path.posix.join("/home/user/work", path.basename(localDir));
}

/**
 * How a device's status reads in the picker and in `ccbeam devices`.
 *
 * The cloud row says what it is costing you. That is not decoration: a tool
 * that can quietly leave a metered VM running owes you a visible answer to
 * "am I being billed right now".
 */
export function describeState(row) {
  if (row.isCurrent) return "you are here";
  if (row.isCloud) {
    if (!row.configured) return "not set up yet";
    if (row.state === "running") return "running";
    if (row.state === "paused") return "paused";
    return "";
  }
  return "";
}
