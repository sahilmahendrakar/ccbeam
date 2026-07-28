#!/usr/bin/env node
/** Unit tests for the pure parts: slugs, targets, devices, carrying and seeding. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyBundle, captureBundle, fingerprint } from "../src/carry.mjs";
import { run } from "../src/exec.mjs";
import { slug } from "../src/paths.mjs";
import { parseTarget } from "../src/request.mjs";
import { seedRepo } from "../src/seed.mjs";
import { install as installShell, rcFileFor, uninstall as uninstallShell } from "../src/shell.mjs";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "beamup-unit-"));

test("slug matches Claude Code's directory naming", () => {
  // Verified against real Claude Code output.
  assert.equal(slug("/home/ec2-user/dev"), "-home-ec2-user-dev");
  assert.equal(slug("/tmp/cct.slug_test-x"), "-tmp-cct-slug-test-x");
  assert.equal(slug("/tmp"), "-tmp");
});

test("parseTarget handles every form the user can type", () => {
  assert.deepEqual(parseTarget(""), { device: null, dir: null, home: false });
  assert.deepEqual(parseTarget("gpu-box"), { device: "gpu-box", dir: null, home: false });
  assert.deepEqual(parseTarget("gpu-box:~/src"), { device: "gpu-box", dir: "~/src", home: false });
  assert.deepEqual(parseTarget("local"), { device: "local", dir: null, home: false });
  assert.deepEqual(parseTarget("cloud"), { device: "cloud", dir: null, home: false });
  assert.deepEqual(parseTarget("  gpu:/a/b  "), { device: "gpu", dir: "/a/b", home: false });
});

test("`home` is reserved, but a device named home stays reachable", () => {
  assert.deepEqual(parseTarget("home"), { device: null, dir: null, home: true });
  assert.deepEqual(parseTarget("HOME"), { device: null, dir: null, home: true });
  // Explicit folder syntax escapes the reservation.
  assert.deepEqual(parseTarget("home:~/src"), { device: "home", dir: "~/src", home: false });
});

async function makeRepo() {
  const dir = tmp();
  await run("git", ["-C", dir, "init", "-q"]);
  await run("git", ["-C", dir, "config", "user.email", "t@t"]);
  await run("git", ["-C", dir, "config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "tracked.txt"), "original\n");
  await run("git", ["-C", dir, "add", "-A"]);
  await run("git", ["-C", dir, "commit", "-qm", "base"]);
  return dir;
}

test("carrying work moves both edits and new files", async () => {
  const origin = await makeRepo();
  const clone = tmp();
  await run("git", ["clone", "-q", origin, clone]);

  fs.writeFileSync(path.join(origin, "tracked.txt"), "edited on the laptop\n");
  fs.writeFileSync(path.join(origin, "brand-new.txt"), "untracked\n");

  const bundle = tmp();
  const captured = await captureBundle(origin, bundle);
  assert.equal(captured.ok, true);
  assert.equal(captured.empty, false);
  assert.deepEqual(captured.untracked, ["brand-new.txt"]);

  const applied = await applyBundle(clone, bundle);
  assert.equal(applied.ok, true, `apply failed: ${applied.reason} ${applied.detail ?? ""}`);
  assert.equal(fs.readFileSync(path.join(clone, "tracked.txt"), "utf8"), "edited on the laptop\n");
  assert.equal(fs.readFileSync(path.join(clone, "brand-new.txt"), "utf8"), "untracked\n");
});

test("carrying refuses when the destination is on a different commit", async () => {
  const origin = await makeRepo();
  const clone = tmp();
  await run("git", ["clone", "-q", origin, clone]);

  // The destination moves ahead — the exact case that silently loses work.
  fs.writeFileSync(path.join(clone, "tracked.txt"), "diverged\n");
  await run("git", ["-C", clone, "commit", "-aqm", "diverge"]);

  fs.writeFileSync(path.join(origin, "tracked.txt"), "edited\n");
  const bundle = tmp();
  await captureBundle(origin, bundle);

  const applied = await applyBundle(clone, bundle);
  assert.equal(applied.ok, false);
  assert.equal(applied.reason, "head-mismatch");
});

test("carrying refuses to clobber a dirty destination", async () => {
  const origin = await makeRepo();
  const clone = tmp();
  await run("git", ["clone", "-q", origin, clone]);

  fs.writeFileSync(path.join(clone, "tracked.txt"), "someone else was working here\n");
  fs.writeFileSync(path.join(origin, "tracked.txt"), "edited\n");

  const bundle = tmp();
  await captureBundle(origin, bundle);
  const applied = await applyBundle(clone, bundle);
  assert.equal(applied.ok, false);
  assert.equal(applied.reason, "destination-dirty");
});

test("returning replaces the departure state instead of stacking on it", async () => {
  const origin = await makeRepo();
  const remote = tmp();
  await run("git", ["clone", "-q", origin, remote]);

  // Leave with changes.
  fs.writeFileSync(path.join(origin, "tracked.txt"), "from the laptop\n");
  fs.writeFileSync(path.join(origin, "note.txt"), "laptop note\n");
  const outbound = tmp();
  const departure = await captureBundle(origin, outbound);
  await applyBundle(remote, outbound);

  // Work continues out there.
  fs.writeFileSync(path.join(remote, "tracked.txt"), "from the laptop, then the server\n");
  fs.writeFileSync(path.join(remote, "server.txt"), "made remotely\n");

  const inbound = tmp();
  await captureBundle(remote, inbound);
  const back = await applyBundle(origin, inbound, {
    replacing: { untracked: departure.untracked },
  });

  assert.equal(back.ok, true, `apply failed: ${back.reason} ${back.detail ?? ""}`);
  assert.equal(fs.readFileSync(path.join(origin, "tracked.txt"), "utf8"), "from the laptop, then the server\n");
  assert.equal(fs.readFileSync(path.join(origin, "server.txt"), "utf8"), "made remotely\n");
  assert.equal(fs.existsSync(path.join(origin, "note.txt")), true, "the note we carried out should still be here");
});

test("fingerprint detects a tree changing while you are away", async () => {
  const dir = await makeRepo();
  const before = await fingerprint(dir);
  fs.writeFileSync(path.join(dir, "tracked.txt"), "someone typed here\n");
  const after = await fingerprint(dir);
  assert.notEqual(before, after);
});

test("shell integration installs, is idempotent, and removes cleanly", async () => {
  const dir = tmp();
  const rc = path.join(dir, ".zshrc");
  const before = "export PATH=/usr/local/bin:$PATH\nalias ll='ls -la'\n";
  fs.writeFileSync(rc, before);

  const first = installShell({ shell: "zsh", rcFile: rc });
  assert.equal(first.action, "installed");
  assert.equal(fs.existsSync(first.backup), true, "should back the file up before editing");
  assert.match(fs.readFileSync(rc, "utf8"), /claude\(\) \{ command beamup "\$@"; \}/);

  const second = installShell({ shell: "zsh", rcFile: rc });
  assert.equal(second.action, "already", "installing twice must not duplicate the block");

  const removed = uninstallShell({ shell: "zsh", rcFile: rc });
  assert.equal(removed.action, "removed");
  assert.equal(fs.readFileSync(rc, "utf8"), before, "removal must restore the file exactly");
});

test("shell integration writes a valid fish function", () => {
  const rc = path.join(tmp(), "config.fish");
  installShell({ shell: "fish", rcFile: rc });
  const text = fs.readFileSync(rc, "utf8");
  assert.match(text, /function claude\n {4}command beamup \$argv\nend/);
  assert.equal(uninstallShell({ shell: "fish", rcFile: rc }).action, "removed");
});

test("shell integration notices an existing claude alias", () => {
  const rc = path.join(tmp(), ".bashrc");
  fs.writeFileSync(rc, "alias claude='claude --model opus'\n");
  const result = installShell({ shell: "bash", rcFile: rc });
  assert.equal(result.conflict, true, "should warn rather than silently shadow");
});

test("shell integration creates a missing rc file", () => {
  const rc = path.join(tmp(), "nested", ".bashrc");
  const result = installShell({ shell: "bash", rcFile: rc });
  assert.equal(result.action, "installed");
  assert.equal(result.backup, null, "nothing to back up when the file did not exist");
  assert.match(fs.readFileSync(rc, "utf8"), /beamup/);
});

test("rc file location respects ZDOTDIR and XDG_CONFIG_HOME", () => {
  assert.equal(rcFileFor("zsh", { ZDOTDIR: "/custom" }, "/home/u"), "/custom/.zshrc");
  assert.equal(rcFileFor("zsh", {}, "/home/u"), "/home/u/.zshrc");
  assert.equal(rcFileFor("fish", { XDG_CONFIG_HOME: "/cfg" }, "/home/u"), "/cfg/fish/config.fish");
  assert.equal(rcFileFor("bash", {}, "/home/u"), "/home/u/.bashrc");
});

/**
 * A Device that is just this machine.
 *
 * The point of the Device seam is that everything above it is transport-free,
 * which means the seeding and carrying logic can be driven for real — bash,
 * git, tar, the lot — with no ssh host and no cloud account in sight.
 */
class FakeDevice {
  constructor() {
    this.name = "fake";
    this.kind = "ssh";
  }
  async ensureUp() {
    return { ok: true };
  }
  async exec(script) {
    return run("bash", ["-c", script]);
  }
  async pushDir(localDir, remoteDir) {
    return run("bash", ["-c", `mkdir -p "${remoteDir}" && cp -a "${localDir}/." "${remoteDir}/"`]);
  }
  async pullDir(remoteDir, localDir) {
    return run("bash", ["-c", `mkdir -p "${localDir}" && cp -a "${remoteDir}/." "${localDir}/"`]);
  }
  async release() {
    return null;
  }
  async dispose() {}
}

test("seeding puts a fresh device on the exact commit we left", async () => {
  const origin = await makeRepo();
  fs.writeFileSync(path.join(origin, "second.txt"), "more history\n");
  await run("git", ["-C", origin, "add", "-A"]);
  await run("git", ["-C", origin, "commit", "-qm", "second"]);
  const head = (await run("git", ["-C", origin, "rev-parse", "HEAD"])).stdout.trim();
  const branch = (await run("git", ["-C", origin, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();

  const dest = path.join(tmp(), "landing");
  const result = await seedRepo({
    device: new FakeDevice(),
    localDir: origin,
    remoteDir: dest,
    home: tmp(),
  });

  assert.equal(result.seeded, true, `seed failed: ${result.error}`);
  assert.equal(result.head, head);
  assert.equal((await run("git", ["-C", dest, "rev-parse", "HEAD"])).stdout.trim(), head, "must land on the same commit");
  assert.equal((await run("git", ["-C", dest, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim(), branch);
  assert.equal(fs.readFileSync(path.join(dest, "second.txt"), "utf8"), "more history\n");
  // The bundle was a transport, not a remote worth keeping.
  assert.equal((await run("git", ["-C", dest, "remote"])).stdout.trim(), "");
});

test("seeding a carried patch onto a fresh device applies cleanly", async () => {
  // The whole reason seeding exists: a patch may only land on its own base
  // commit, and a brand-new cloud box has no commits at all.
  const origin = await makeRepo();
  fs.writeFileSync(path.join(origin, "tracked.txt"), "edited before leaving\n");
  fs.writeFileSync(path.join(origin, "fresh.txt"), "brand new\n");

  const dest = path.join(tmp(), "landing");
  const device = new FakeDevice();
  const seeded = await seedRepo({ device, localDir: origin, remoteDir: dest, home: tmp() });
  assert.equal(seeded.seeded, true, `seed failed: ${seeded.error}`);

  const bundle = tmp();
  await captureBundle(origin, bundle);
  const applied = await applyBundle(dest, bundle);
  assert.equal(applied.ok, true, `apply failed: ${applied.reason} ${applied.detail ?? ""}`);
  assert.equal(fs.readFileSync(path.join(dest, "tracked.txt"), "utf8"), "edited before leaving\n");
  assert.equal(fs.readFileSync(path.join(dest, "fresh.txt"), "utf8"), "brand new\n");
});

test("seeding survives a detached HEAD", async () => {
  const origin = await makeRepo();
  fs.writeFileSync(path.join(origin, "tracked.txt"), "second\n");
  await run("git", ["-C", origin, "commit", "-aqm", "second"]);
  await run("git", ["-C", origin, "checkout", "-q", "--detach", "HEAD~1"]);
  const head = (await run("git", ["-C", origin, "rev-parse", "HEAD"])).stdout.trim();

  const dest = path.join(tmp(), "landing");
  const result = await seedRepo({ device: new FakeDevice(), localDir: origin, remoteDir: dest, home: tmp() });
  assert.equal(result.seeded, true, `seed failed: ${result.error}`);
  assert.equal((await run("git", ["-C", dest, "rev-parse", "HEAD"])).stdout.trim(), head);
});

test("seeding is a no-op where the repo already is", async () => {
  const origin = await makeRepo();
  const dest = tmp();
  await run("git", ["clone", "-q", origin, dest]);
  const result = await seedRepo({ device: new FakeDevice(), localDir: origin, remoteDir: dest, home: tmp() });
  assert.equal(result.seeded, false, "an ssh box you have used before must not be re-cloned");
  assert.equal(result.error, undefined);
});

test("the device list always offers cloud, and ssh config cannot shadow it", async () => {
  // Point HOME at a scratch dir so this reads our fixtures, not the real ones.
  const home = tmp();
  const realHome = process.env.HOME;
  fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".ssh", "config"),
    ["Host gpu-box", "  HostName 10.0.0.1", "Host cloud", "  HostName imposter", "Host *", "  User me", ""].join("\n"),
  );
  process.env.HOME = home;
  try {
    const { CLOUD, LOCAL, cloudWorkDir, describeState, devices, sshHosts } = await import(
      `../src/devices.mjs?fresh=${Date.now()}`
    );
    assert.deepEqual(sshHosts(), ["gpu-box"], "`cloud` in ssh config must not become a device");

    const rows = devices(LOCAL);
    assert.equal(rows[0].name, LOCAL, "local is always first");
    assert.equal(rows[rows.length - 1].name, CLOUD, "cloud is always last");
    assert.equal(rows.filter((r) => r.name === CLOUD).length, 1, "exactly one cloud row");
    assert.equal(describeState(rows[rows.length - 1]), "not set up yet");
    assert.equal(cloudWorkDir("/home/me/dev/jungle"), "/home/user/work/jungle");
  } finally {
    process.env.HOME = realHome;
  }
});

for (const [name, fn] of tests) {
  try {
    await fn();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    process.stdout.write(`  ✕ ${name}\n    ${err.message}\n`);
    process.exitCode = 1;
  }
}
process.stdout.write(`\n  ${passed}/${tests.length} passed\n`);
