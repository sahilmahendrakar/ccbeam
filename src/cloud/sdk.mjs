/**
 * Loading the E2B SDK, but only if you asked for a cloud box.
 *
 * `npm i -g ccbeam` must not drag a cloud provider's SDK onto your machine for
 * a feature you have not used — the core is provider-agnostic and should stay
 * cheap to install. So `e2b` is not a dependency of this package at all. It is
 * fetched into ~/.ccbeam/deps the first time you set the cloud box up, and
 * loaded from there.
 *
 * The same mechanism is what a second provider (Fly, Modal, a plain VM) would
 * use. Nothing here is E2B-shaped except the package name.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { run } from "../exec.mjs";
import { stateDir } from "../paths.mjs";

export const PACKAGE = "e2b";

/**
 * Pinned exactly, and deliberately not a range.
 *
 * Because the SDK is fetched at runtime there is no lockfile in front of it, so
 * a range means each machine gets whatever was newest on the day it first ran
 * the cloud path. That is not hypothetical: `^2.2.1` put the machine this was
 * written on at 2.2.1 and a laptop set up two days later at 2.36.1, where
 * `Sandbox.betaCreate` no longer exists. E2B renames things across minors, so
 * an exact pin is the only way the code you run is the code that was tested.
 * Bumping it is a code change with a test run attached — which is the point.
 */
export const VERSION = "2.36.1";

/**
 * e2b dropped Node 18 in 2.5.0 and excludes Node 21 from 2.33 on. ccbeam itself
 * still runs on 18; this applies to the cloud box only, which is why it is
 * checked here rather than in package.json's engines.
 */
export const NODE_REQUIREMENT = "20.18.1 or newer (but not 21.x)";

export function nodeSupported(v = process.versions.node) {
  const [major, minor, patch] = v.split(".").map(Number);
  if (major === 21 || major < 20) return false;
  if (major > 21) return true;
  return minor > 18 || (minor === 18 && patch >= 1);
}

const depsDir = () => path.join(stateDir(), "deps");

/** Resolve the SDK's ESM entry point and version from one starting point. */
function resolveFrom(from) {
  try {
    const require = createRequire(from);
    const pkgPath = require.resolve(`${PACKAGE}/package.json`);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const rel = pkg.module || pkg.main;
    if (!rel) return null;
    return { entry: path.join(path.dirname(pkgPath), rel), version: pkg.version };
  } catch {
    return null;
  }
}

/**
 * Ours first, then one the user installed themselves. Ours is preferred even
 * when both exist: the pin is the whole guarantee, and a copy we did not choose
 * is a copy nobody tested this against.
 */
function resolveEntry() {
  return resolveFrom(path.join(depsDir(), "package.json")) ?? resolveFrom(import.meta.url);
}

/** Already available? Returns the module plus the version it came from. */
export async function loadE2B() {
  const found = resolveEntry();
  if (!found) return null;
  return { module: await import(pathToFileURL(found.entry).href), version: found.version };
}

/**
 * Load the SDK, fetching it first if this is the first cloud box on this
 * machine. Returns the module, or an error we can show the user.
 */
export async function ensureE2B({ onProgress = () => {} } = {}) {
  if (!nodeSupported()) {
    return {
      ok: false,
      error:
        `the cloud box needs Node ${NODE_REQUIREMENT} — this is Node ${process.versions.node}. ` +
        `(The e2b SDK dropped Node 18; ssh devices are unaffected.)`,
    };
  }

  const existing = await loadE2B();
  if (existing?.version === VERSION) return { ok: true, e2b: existing.module, version: existing.version };

  const dir = depsDir();
  fs.mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, "package.json");
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(
      manifest,
      JSON.stringify({ name: "ccbeam-deps", private: true, description: "Optional provider SDKs, fetched on demand." }, null, 2) + "\n",
    );
  }

  onProgress(
    existing
      ? `updating the ${PACKAGE} SDK ${existing.version} → ${VERSION} (into ~/.ccbeam/deps)`
      : `fetching the ${PACKAGE} SDK (once, into ~/.ccbeam/deps)`,
  );
  const installed = await run(
    "npm",
    ["install", "--prefix", dir, "--no-audit", "--no-fund", "--loglevel", "error", `${PACKAGE}@${VERSION}`],
    { timeout: 180000 },
  );

  const loaded = await loadE2B();
  if (installed.code !== 0) {
    // An older copy on disk beats no cloud box at all — the call sites choose
    // their API shape by capability, so a version we did not pick still works.
    // Only say the install failed if there is nothing usable to fall back to.
    if (loaded) return { ok: true, e2b: loaded.module, version: loaded.version };
    return {
      ok: false,
      error: `could not install ${PACKAGE}@${VERSION}: ${installed.stderr.trim().split("\n").pop() || `npm exited ${installed.code}`}`,
    };
  }
  if (!loaded) return { ok: false, error: `installed ${PACKAGE}@${VERSION} but could not load it` };
  return { ok: true, e2b: loaded.module, version: loaded.version };
}
