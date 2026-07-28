/**
 * Where the cloud box's details live.
 *
 * Two things are stored, and it matters which: the E2B key, which is *yours*
 * and never leaves this machine except to talk to E2B, and the id of the
 * sandbox we created on your account so we can find it again next time. beamup
 * runs no infrastructure — there is nothing here that points at anything the
 * maintainers operate.
 */
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "../paths.mjs";

export const CONFIG_FILE = () => path.join(stateDir(), "config.json");

/** E2B's default sandbox image. We add node + Claude Code to it once, on first
 *  use, and the paused snapshot keeps them forever after — so beamup never
 *  depends on a template published under a maintainer's account. */
export const BASE_TEMPLATE = "base";

/** The box pauses itself when this expires, even if beamup is killed -9. */
export const BACKSTOP_MS = 60 * 60 * 1000; // 1 hour — safe on E2B's Hobby tier

/** How long a box sits idle after you leave before it pauses itself. */
export const IDLE_GRACE_MS = 5 * 60 * 1000;

export function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE(), "utf8"));
  } catch {
    return {};
  }
}

export function writeConfig(config) {
  const file = CONFIG_FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  return config;
}

/** Merge a patch into the stored cloud section. */
export function patchCloud(patch) {
  const config = readConfig();
  config.cloud = { ...(config.cloud ?? {}), ...patch };
  return writeConfig(config);
}

export function readCloud() {
  return readConfig().cloud ?? null;
}

/**
 * The environment wins over the file, so a key you export for one shell never
 * silently loses to one you saved months ago.
 */
export function apiKey(env = process.env) {
  return env.E2B_API_KEY || readConfig().e2b?.apiKey || null;
}

export function saveApiKey(key) {
  const config = readConfig();
  config.e2b = { ...(config.e2b ?? {}), apiKey: key };
  return writeConfig(config);
}

/** Has the user set the cloud box up at all? */
export function isConfigured(env = process.env) {
  return Boolean(apiKey(env) && readCloud()?.sandboxId);
}
