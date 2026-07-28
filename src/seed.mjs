/**
 * Putting a repository on a device that has never seen it.
 *
 * A machine you ssh to already has your code — you cloned it there months ago.
 * A cloud box created ten seconds ago has nothing, and that breaks the rule the
 * whole carry mechanism rests on: a patch may only be applied to the same
 * commit it was written against. So before any uncommitted work travels, the
 * destination has to be standing on that exact commit.
 *
 * It is seeded from *this* machine, via `git bundle` — not from GitHub. That is
 * a deliberate choice with three consequences worth keeping:
 *   - it works on repos you have never pushed anywhere;
 *   - it works on branches that only exist locally;
 *   - the box never needs a credential for your git host, so there is no second
 *     slippery slope next to the one about Claude credentials.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { q, run } from "./exec.mjs";
import { isRepo } from "./carry.mjs";

/** Bundles bigger than this are worth a word before we spend the bandwidth. */
export const LARGE_BUNDLE_BYTES = 100 * 1024 * 1024;

const git = (dir, args) => run("git", ["-C", dir, ...args]);

/**
 * Package a repository's history so it can be cloned somewhere else at the
 * identical commit. Returns the bundle plus what the far side needs to know to
 * check out the same place.
 */
export async function bundleRepo(localDir, bundleDir) {
  if (!(await isRepo(localDir))) return { ok: false, reason: "not-a-git-repo" };

  const head = (await git(localDir, ["rev-parse", "HEAD"])).stdout.trim();
  if (!head) return { ok: false, reason: "no-commits" };
  const branch = (await git(localDir, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  const detached = branch === "HEAD";

  fs.mkdirSync(bundleDir, { recursive: true });
  const file = path.join(bundleDir, "repo.bundle");

  // `git bundle` takes rev-list arguments, not refspecs. On a branch we bundle
  // that branch by name so the far side can clone it directly; detached, we
  // take every ref plus HEAD's own commit (which may be reachable from none of
  // them) and check the commit out explicitly over there.
  const created = detached
    ? await git(localDir, ["bundle", "create", file, "--all", "HEAD"])
    : await git(localDir, ["bundle", "create", file, branch]);
  if (created.code !== 0) {
    return { ok: false, reason: "bundle-failed", detail: created.stderr.trim() };
  }

  return {
    ok: true,
    file,
    head,
    branch: detached ? null : branch,
    detached,
    bytes: fs.statSync(file).size,
  };
}

/** The commands that turn a bundle into a working tree on the far side. */
export function cloneScript({ bundleFile, remoteDir, branch, head, detached }) {
  const clone = detached
    ? `git clone -q ${q(bundleFile)} ${q(remoteDir)}`
    : `git clone -q --branch ${q(branch)} ${q(bundleFile)} ${q(remoteDir)}`;
  return [
    clone,
    // The bundle is a throwaway transport, not a remote worth remembering.
    `git -C ${q(remoteDir)} remote remove origin 2>/dev/null || true`,
    // Land on the exact commit the carried patch was written against.
    `git -C ${q(remoteDir)} checkout -q --detach ${q(head)}`,
    detached ? "true" : `git -C ${q(remoteDir)} checkout -q ${q(branch)}`,
  ].join(" && ");
}

/**
 * Make sure `remoteDir` on `device` is a repo standing on the same commit as
 * `localDir`. A no-op when the device already has one — which is the normal
 * case for every ssh device, and for a cloud box after its first visit.
 */
export async function seedRepo({ device, localDir, remoteDir, home, onProgress = () => {} }) {
  const already = await device.exec(
    `git -C ${q(remoteDir)} rev-parse --git-dir >/dev/null 2>&1 && echo yes || echo no`,
  );
  if (already.stdout.trim() === "yes") return { seeded: false };
  if (!(await isRepo(localDir))) return { seeded: false };

  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccbeam-seed-"));
  try {
    const bundle = await bundleRepo(localDir, bundleDir);
    if (!bundle.ok) return { seeded: false, error: `could not package the repo (${bundle.reason})` };
    if (bundle.bytes > LARGE_BUNDLE_BYTES) {
      onProgress(`shipping ${Math.round(bundle.bytes / 1e6)}MB of history — this is the slow part, once`);
    }

    const remoteSeed = `${home}/.ccbeam/seed`;
    await device.exec(`rm -rf ${q(remoteSeed)}`);
    const sent = await device.pushDir(bundleDir, remoteSeed);
    if (sent.code !== 0) return { seeded: false, error: `could not ship the repo: ${sent.stderr}` };

    // Clone needs the directory absent or empty; beamOut has only just made it.
    const cloned = await device.exec(
      [
        `rmdir ${q(remoteDir)} 2>/dev/null || true`,
        cloneScript({
          bundleFile: `${remoteSeed}/repo.bundle`,
          remoteDir,
          branch: bundle.branch,
          head: bundle.head,
          detached: bundle.detached,
        }),
      ].join("; "),
      { timeout: 300000 },
    );
    await device.exec(`rm -rf ${q(remoteSeed)}`);

    if (cloned.code !== 0) {
      return { seeded: false, error: `could not lay down the repo: ${cloned.stderr.trim().split("\n").pop()}` };
    }
    return { seeded: true, head: bundle.head, branch: bundle.branch };
  } finally {
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
}
