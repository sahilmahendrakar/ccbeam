#!/usr/bin/env node
/** Unit tests for the pure parts: slugs, targets, machines, carrying work. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyBundle, captureBundle, fingerprint } from "../src/carry.mjs";
import { run } from "../src/exec.mjs";
import { slug } from "../src/paths.mjs";
import { parseTarget } from "../src/request.mjs";
import { install as installShell, rcFileFor, uninstall as uninstallShell } from "../src/shell.mjs";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cct-unit-"));

test("slug matches Claude Code's directory naming", () => {
  // Verified against real Claude Code output.
  assert.equal(slug("/home/ec2-user/dev"), "-home-ec2-user-dev");
  assert.equal(slug("/tmp/cct.slug_test-x"), "-tmp-cct-slug-test-x");
  assert.equal(slug("/tmp"), "-tmp");
});

test("parseTarget handles every form the user can type", () => {
  assert.deepEqual(parseTarget(""), { machine: null, dir: null });
  assert.deepEqual(parseTarget("gpu-box"), { machine: "gpu-box", dir: null });
  assert.deepEqual(parseTarget("gpu-box:~/src"), { machine: "gpu-box", dir: "~/src" });
  assert.deepEqual(parseTarget("local"), { machine: "local", dir: null });
  assert.deepEqual(parseTarget("  gpu:/a/b  "), { machine: "gpu", dir: "/a/b" });
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
  assert.match(fs.readFileSync(rc, "utf8"), /claude\(\) \{ command ccteleport "\$@"; \}/);

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
  assert.match(text, /function claude\n {4}command ccteleport \$argv\nend/);
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
  assert.match(fs.readFileSync(rc, "utf8"), /ccteleport/);
});

test("rc file location respects ZDOTDIR and XDG_CONFIG_HOME", () => {
  assert.equal(rcFileFor("zsh", { ZDOTDIR: "/custom" }, "/home/u"), "/custom/.zshrc");
  assert.equal(rcFileFor("zsh", {}, "/home/u"), "/home/u/.zshrc");
  assert.equal(rcFileFor("fish", { XDG_CONFIG_HOME: "/cfg" }, "/home/u"), "/cfg/fish/config.fish");
  assert.equal(rcFileFor("bash", {}, "/home/u"), "/home/u/.bashrc");
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
