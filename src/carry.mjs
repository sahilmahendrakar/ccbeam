import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { run } from "./exec.mjs";

/**
 * Carrying uncommitted work between machines.
 *
 * The rule that keeps this safe: your changes travel *with* you, and the
 * machine you left is expected to be untouched while you are away. Every
 * operation below either verifies that expectation or refuses and keeps both
 * copies. Nothing is ever silently overwritten.
 */

async function git(dir, args) {
  return run("git", ["-C", dir, ...args]);
}

export async function isRepo(dir) {
  return (await git(dir, ["rev-parse", "--git-dir"])).code === 0;
}

/** A stable summary of a working tree's uncommitted state. */
export async function fingerprint(dir) {
  if (!(await isRepo(dir))) return null;
  const status = await git(dir, ["status", "--porcelain"]);
  const diff = await git(dir, ["diff", "HEAD"]);
  return crypto.createHash("sha256").update(status.stdout).update(diff.stdout).digest("hex");
}

/**
 * Package a working tree's uncommitted changes into a directory we can ship.
 * Returns a summary, or a reason we can show the user for not carrying.
 */
export async function captureBundle(dir, bundleDir) {
  if (!(await isRepo(dir))) return { ok: false, reason: "not-a-git-repo" };

  const head = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
  const branch = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  const patch = await git(dir, ["diff", "HEAD", "--binary"]);
  const untrackedOut = await git(dir, ["ls-files", "--others", "--exclude-standard"]);
  const untracked = untrackedOut.stdout.split("\n").filter(Boolean);

  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, "changes.patch"), patch.stdout);
  fs.writeFileSync(
    path.join(bundleDir, "meta.json"),
    JSON.stringify({ head, branch, untracked, fingerprint: await fingerprint(dir) }, null, 2),
  );

  if (untracked.length) {
    const list = path.join(bundleDir, "untracked.list");
    fs.writeFileSync(list, untracked.join("\n") + "\n");
    await run("tar", ["czf", path.join(bundleDir, "untracked.tar.gz"), "-C", dir, "-T", list]);
  }

  const changedFiles = new Set(untracked);
  for (const line of patch.stdout.split("\n")) {
    const m = line.match(/^\+\+\+ b\/(.+)$/);
    if (m) changedFiles.add(m[1]);
  }

  return {
    ok: true,
    head,
    branch,
    empty: !patch.stdout.trim() && untracked.length === 0,
    files: changedFiles.size,
    untracked,
  };
}

/**
 * Apply a bundle onto a destination tree. Refuses on a commit mismatch or a
 * dirty destination rather than guessing — a patch applied to the wrong base is
 * exactly how uncommitted work disappears.
 */
export async function applyBundle(dir, bundleDir, { expectClean = true, replacing = null } = {}) {
  const metaFile = path.join(bundleDir, "meta.json");
  if (!fs.existsSync(metaFile)) return { ok: false, reason: "no-bundle" };
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));

  if (!(await isRepo(dir))) return { ok: false, reason: "not-a-git-repo" };

  const head = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
  if (head !== meta.head) {
    return { ok: false, reason: "head-mismatch", theirs: meta.head, ours: head, branch: meta.branch };
  }

  // Returning home: put the tree back the way we left it before laying down the
  // newer version, so the two sets of changes cannot interleave.
  if (replacing) {
    await git(dir, ["checkout", "--", "."]);
    for (const rel of replacing.untracked ?? []) {
      try {
        fs.rmSync(path.join(dir, rel), { force: true });
      } catch {
        /* nothing to remove */
      }
    }
  } else if (expectClean) {
    const status = await git(dir, ["status", "--porcelain"]);
    if (status.stdout.trim()) return { ok: false, reason: "destination-dirty", detail: status.stdout.trim() };
  }

  const patchFile = path.join(bundleDir, "changes.patch");
  if (fs.existsSync(patchFile) && fs.readFileSync(patchFile, "utf8").trim()) {
    const applied = await run("git", ["-C", dir, "apply", "--binary", "--whitespace=nowarn", patchFile]);
    if (applied.code !== 0) return { ok: false, reason: "patch-failed", detail: applied.stderr.trim() };
  }

  const tarball = path.join(bundleDir, "untracked.tar.gz");
  if (fs.existsSync(tarball)) {
    const x = await run("tar", ["xzf", tarball, "-C", dir]);
    if (x.code !== 0) return { ok: false, reason: "untracked-failed", detail: x.stderr.trim() };
  }

  return { ok: true, files: (meta.untracked?.length ?? 0) + countPatchFiles(patchFile) };
}

function countPatchFiles(patchFile) {
  try {
    return fs
      .readFileSync(patchFile, "utf8")
      .split("\n")
      .filter((l) => /^\+\+\+ b\//.test(l)).length;
  } catch {
    return 0;
  }
}

export function describeRefusal(result) {
  switch (result.reason) {
    case "head-mismatch":
      return `the destination is on ${result.ours.slice(0, 7)}, your changes were written against ${result.theirs.slice(0, 7)}`;
    case "destination-dirty":
      return "the destination has its own uncommitted changes";
    case "patch-failed":
      return `the patch did not apply cleanly (${result.detail?.split("\n")[0] ?? "conflict"})`;
    case "not-a-git-repo":
      return "not a git repository";
    default:
      return result.reason ?? "unknown";
  }
}
