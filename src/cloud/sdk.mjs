/**
 * Loading the E2B SDK, but only if you asked for a cloud box.
 *
 * `npm i -g beamup` must not drag a cloud provider's SDK onto your machine for
 * a feature you have not used — the core is provider-agnostic and should stay
 * cheap to install. So `e2b` is not a dependency of this package at all. It is
 * fetched into ~/.beamup/deps the first time you set the cloud box up, and
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
export const VERSION_RANGE = "^2.2.1";

const depsDir = () => path.join(stateDir(), "deps");

/** Resolve the SDK's ESM entry point, wherever it happens to live. */
function resolveEntry() {
  const candidates = [
    // Installed by us.
    path.join(depsDir(), "package.json"),
    // Or already present because the user installed it themselves.
    import.meta.url,
  ];
  for (const from of candidates) {
    try {
      const require = createRequire(from);
      const pkgPath = require.resolve(`${PACKAGE}/package.json`);
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const rel = pkg.module || pkg.main;
      if (!rel) continue;
      return path.join(path.dirname(pkgPath), rel);
    } catch {
      /* try the next place */
    }
  }
  return null;
}

/** Already available? */
export async function loadE2B() {
  const entry = resolveEntry();
  if (!entry) return null;
  return import(pathToFileURL(entry).href);
}

/**
 * Load the SDK, fetching it first if this is the first cloud box on this
 * machine. Returns the module, or an error we can show the user.
 */
export async function ensureE2B({ onProgress = () => {} } = {}) {
  const existing = await loadE2B();
  if (existing) return { ok: true, e2b: existing };

  const dir = depsDir();
  fs.mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, "package.json");
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(
      manifest,
      JSON.stringify({ name: "beamup-deps", private: true, description: "Optional provider SDKs, fetched on demand." }, null, 2) + "\n",
    );
  }

  onProgress(`fetching the ${PACKAGE} SDK (once, into ~/.beamup/deps)`);
  const installed = await run(
    "npm",
    ["install", "--prefix", dir, "--no-audit", "--no-fund", "--loglevel", "error", `${PACKAGE}@${VERSION_RANGE}`],
    { timeout: 180000 },
  );
  if (installed.code !== 0) {
    return {
      ok: false,
      error: `could not install ${PACKAGE}: ${installed.stderr.trim().split("\n").pop() || `npm exited ${installed.code}`}`,
    };
  }

  const loaded = await loadE2B();
  if (!loaded) return { ok: false, error: `installed ${PACKAGE} but could not load it` };
  return { ok: true, e2b: loaded };
}
