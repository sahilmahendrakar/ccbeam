#!/usr/bin/env node
/**
 * End-to-end tests.
 *
 * Part A drives the real supervisor with real Claude Code sessions and checks
 * that a conversation survives a move — the property the whole product rests on.
 * Part B drives the ssh machinery against a real sshd, checking that the
 * transcript and uncommitted work land where they should on the far side.
 *
 * Part B needs a reachable host; set CCBEAM_HOST (default: ccbeam-localhost).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { cleanEnv, run } from "../src/exec.mjs";
import { configDir, projectDir, slug } from "../src/paths.mjs";
import { checkDevice, beamBack, beamOut, checkPlugin, pushRuntime, remoteRuntime } from "../src/move.mjs";
import { SshDevice } from "../src/device/ssh.mjs";

const HOST = process.env.CCBEAM_HOST || "ccbeam-localhost";
/** Part B drives a real ssh device through the same seam the supervisor uses. */
const device = new SshDevice(HOST);
const BIN = path.resolve(new URL("../bin/ccbeam.mjs", import.meta.url).pathname);
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `ccbeam-e2e-${tag}-`));

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

async function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  await run("git", ["-C", dir, "init", "-q"]);
  await run("git", ["-C", dir, "config", "user.email", "t@t"]);
  await run("git", ["-C", dir, "config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "tracked.txt"), "original\n");
  await run("git", ["-C", dir, "add", "-A"]);
  await run("git", ["-C", dir, "commit", "-qm", "base"]);
  return dir;
}

/** Run the supervisor with scripted prompts, one per leg. */
function supervise(cwd, prompts, timeout = 300000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN], {
      cwd,
      env: cleanEnv({ CCBEAM_TEST_PROMPTS: JSON.stringify(prompts) }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

// ---------------------------------------------------------------- Part A ----

test("A1: a conversation survives a move to another folder", async () => {
  const from = tmp("from");
  const to = tmp("to");
  const codeword = "TANGERINE";

  const { out } = await supervise(from, [
    `The codeword is ${codeword}. Now call the mcp__ccbeam__beam tool with target "local:${to}".`,
    "What was the codeword mentioned earlier in this conversation? Reply with only that word.",
  ]);

  assert.match(out, new RegExp(codeword), `the moved session did not recall the codeword.\n${out}`);

  const landed = fs.readdirSync(projectDir(configDir(), to)).filter((f) => f.endsWith(".jsonl"));
  assert.equal(landed.length, 1, "exactly one session should have landed in the destination");
});

test("A2: the /ccbeam:up slash command drives a real move", async () => {
  const from = tmp("cmd-from");
  const to = tmp("cmd-to");

  // Plugin commands are namespaced. Interactively `/ccbeam:up` resolves when
  // unambiguous; in print mode the full form is required.
  const { out } = await supervise(from, [`/ccbeam:up local:${to}`, "Reply with only the word ARRIVED."]);

  assert.match(out, /ARRIVED/, `the session did not run in the destination.\n${out}`);
  assert.ok(
    fs.existsSync(projectDir(configDir(), to)),
    "the slash command should have moved the session into the destination folder",
  );
});

test("A3: /ccbeam:home comes back from wherever the session is", async () => {
  const from = tmp("home-from");
  const via = tmp("home-via");
  const codeword = "PERISCOPE";

  // Out to another folder by tool, home by the dedicated command, then a third
  // turn that must run back in the folder we started in.
  const { out } = await supervise(from, [
    `The codeword is ${codeword}. Now call the mcp__ccbeam__beam tool with target "local:${via}".`,
    "/ccbeam:home",
    // Asking again from home: the supervisor should say so rather than push a
    // runtime and carry a diff from a folder to itself.
    "/ccbeam:home",
    "Reply with only the codeword mentioned earlier in this conversation.",
  ]);

  assert.match(out, new RegExp(codeword), `the session did not come home with its context.\n${out}`);
  assert.match(out, /already home/, `a second /ccbeam:home should be recognised as a no-op.\n${out}`);
  const back = fs.readdirSync(projectDir(configDir(), from)).filter((f) => f.endsWith(".jsonl"));
  assert.equal(back.length, 1, `the session should have landed back in ${from}`);
});

// ---------------------------------------------------------------- Part B ----

test("B1: the device reports itself ready", async () => {
  const info = await checkDevice(device);
  assert.equal(info.ok, true, `could not reach ${HOST}: ${info.error}`);
  assert.deepEqual(info.missing, [], `${HOST} is missing tools: ${info.missing?.join(", ")}`);
  assert.ok(info.cfg, "should report where Claude Code keeps state on that machine");
});

test("B2: beaming out ships the transcript and carries uncommitted work", async () => {
  const local = await makeRepo(tmp("out-local"));
  const remote = tmp("out-remote");
  await run("git", ["clone", "-q", local, remote]);

  // A session that exists in this folder.
  const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const proj = projectDir(configDir(), local);
  fs.mkdirSync(proj, { recursive: true });
  const body = JSON.stringify({ type: "user", cwd: local, sessionId, message: { role: "user", content: "hello" } });
  fs.writeFileSync(path.join(proj, `${sessionId}.jsonl`), body + "\n");

  // Uncommitted work that should travel with it.
  fs.writeFileSync(path.join(local, "tracked.txt"), "edited before leaving\n");
  fs.writeFileSync(path.join(local, "fresh.txt"), "brand new\n");

  const result = await beamOut({ device, remoteDir: remote, localDir: local, sessionId });
  assert.equal(result.ok, true, `beam failed: ${result.error}`);
  assert.equal(result.carryRefused, undefined, `work was not carried: ${result.carryRefused}`);
  assert.ok(result.carried, "should report carrying work");

  const landedAt = `${result.info.cfg}/projects/${slug(remote)}/${sessionId}.jsonl`;
  const check = await device.exec(`cat ${JSON.stringify(landedAt)}`);
  assert.equal(check.code, 0, `transcript not found at ${landedAt}`);
  assert.match(check.stdout, /hello/, "the shipped transcript should be intact");

  assert.equal(fs.readFileSync(path.join(remote, "tracked.txt"), "utf8"), "edited before leaving\n");
  assert.equal(fs.readFileSync(path.join(remote, "fresh.txt"), "utf8"), "brand new\n");
});

test("B3: returning brings the transcript and the work back", async () => {
  const local = await makeRepo(tmp("back-local"));
  const remote = tmp("back-remote");
  await run("git", ["clone", "-q", local, remote]);

  const sessionId = "11111111-2222-3333-4444-999999999999";
  const proj = projectDir(configDir(), local);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(
    path.join(proj, `${sessionId}.jsonl`),
    JSON.stringify({ type: "user", cwd: local, sessionId, message: { role: "user", content: "outbound" } }) + "\n",
  );

  fs.writeFileSync(path.join(local, "tracked.txt"), "written on the laptop\n");
  const out = await beamOut({ device, remoteDir: remote, localDir: local, sessionId });
  assert.equal(out.ok, true, `beam out failed: ${out.error}`);

  // Work happens out there: the transcript grows and a file is created.
  const remoteProj = `${out.info.cfg}/projects/${slug(remote)}`;
  await device.exec(
    `printf '%s\\n' ${JSON.stringify(JSON.stringify({ type: "assistant", sessionId, message: { role: "assistant", content: "worked remotely" } }))} >> ${JSON.stringify(`${remoteProj}/${sessionId}.jsonl`)}`,
  );
  fs.writeFileSync(path.join(remote, "server-only.txt"), "made on the server\n");

  const back = await beamBack({
    device,
    remoteDir: remote,
    localDir: local,
    sessionId,
    home: out.info.home,
    cfg: out.info.cfg,
    departure: out.departure,
  });
  assert.equal(back.ok, true, `beam back failed: ${back.error}`);
  assert.equal(back.carryRefused, undefined, `work did not come back: ${back.carryRefused}`);

  const transcript = fs.readFileSync(path.join(proj, `${sessionId}.jsonl`), "utf8");
  assert.match(transcript, /worked remotely/, "the remote half of the conversation should have come home");
  assert.equal(fs.readFileSync(path.join(local, "server-only.txt"), "utf8"), "made on the server\n");
  assert.equal(fs.readFileSync(path.join(local, "tracked.txt"), "utf8"), "written on the laptop\n");
});

test("B5: the plugin we ship actually loads over there, and replaces what was there", async () => {
  const info = await checkDevice(device);

  // A file this version doesn't have, left where a previous version's would be.
  const stale = `${remoteRuntime(info.home)}/plugin/commands/gone.md`;
  await device.exec(`mkdir -p $(dirname ${JSON.stringify(stale)}) && echo x > ${JSON.stringify(stale)}`);

  const pushed = await pushRuntime(device, info.home);
  assert.equal(pushed.code, 0, `pushing the runtime failed: ${pushed.stderr}`);
  assert.equal(
    (await device.exec(`test -e ${JSON.stringify(stale)} && echo yes || echo no`)).stdout.trim(),
    "no",
    "a push must replace the runtime, not merge into a previous one",
  );

  // The property that matters: Claude Code over there can load it, so there is
  // a way back. Without this, a beam lands you somewhere with no /ccbeam:up.
  const plugin = await checkPlugin(device, info);
  assert.equal(plugin.ok, true, `the plugin did not load on ${HOST}: ${plugin.error}`);

  // And the check is not vacuous — it fails when the plugin isn't there.
  const missing = await checkPlugin(device, { ...info, home: "/nonexistent" });
  assert.equal(missing.ok, false, "checkPlugin should refuse a directory with no plugin in it");
});

test("B4: a conversation survives a round trip through the supervisor", async () => {
  // The full loop: supervisor -> beam out over ssh (seeding a repo the device
  // has never seen) -> run there -> /ccbeam:up home -> carry the work back.
  const local = await makeRepo(tmp("trip-local"));
  const remote = path.join(tmp("trip-remote"), "seeded");
  const codeword = "MARMALADE";

  fs.writeFileSync(path.join(local, "tracked.txt"), "edited before leaving\n");

  const { out } = await supervise(local, [
    `The codeword is ${codeword}. Now call the mcp__ccbeam__beam tool with target "${HOST}:${remote}".`,
    `Create a file called made-remotely.txt containing the word ${codeword}, then call the mcp__ccbeam__beam tool with target "home".`,
    "Reply with only the word RETURNED.",
  ]);

  assert.match(out, /RETURNED/, `the session did not come home.\n${out}`);
  assert.equal(
    (await device.exec(`git -C ${JSON.stringify(remote)} rev-parse HEAD`)).stdout.trim(),
    (await run("git", ["-C", local, "rev-parse", "HEAD"])).stdout.trim(),
    "the seeded device should stand on the same commit",
  );
  assert.equal(
    fs.readFileSync(path.join(local, "made-remotely.txt"), "utf8").includes(codeword),
    true,
    `work done on ${HOST} should have come home.\n${out}`,
  );
  assert.equal(
    fs.readFileSync(path.join(local, "tracked.txt"), "utf8"),
    "edited before leaving\n",
    "the edit we carried out should still be here",
  );
});

// ---------------------------------------------------------------- Part C ----
// The cloud box. Skipped unless one is already set up (`ccbeam cloud`), because
// these tests start a metered sandbox. They always pause it again, including on
// failure — a test suite that leaves a box running would be worse than no tests.

async function withCloud(fn) {
  const { E2BDevice } = await import("../src/device/e2b.mjs");
  const cloud = new E2BDevice();
  const up = await cloud.ensureUp();
  assert.equal(up.ok, true, `could not wake the cloud box: ${up.error}`);
  try {
    return await fn(cloud);
  } finally {
    const released = await cloud.release().catch((e) => ({ warn: String(e) }));
    assert.ok(released?.note, `the cloud box was NOT paused: ${released?.warn ?? "no result"}`);
  }
}

test("C1: the cloud box reports itself ready", async () => {
  await withCloud(async (cloud) => {
    const info = await checkDevice(cloud);
    assert.equal(info.ok, true, `probe failed: ${info.error}`);
    assert.deepEqual(info.missing, [], `cloud is missing tools: ${info.missing?.join(", ")}`);
    assert.equal(info.home, "/home/user");
  });
});

test("C2: beaming to a fresh cloud folder seeds the repo and carries work home", async () => {
  await withCloud(async (cloud) => {
    const local = await makeRepo(tmp("cloud-local"));
    // A folder the box has never seen: seeding has to build the repo from here.
    const remote = `/home/user/work/e2e-${Date.now()}`;

    const sessionId = `cccccccc-dddd-eeee-ffff-${String(Date.now()).slice(-12)}`;
    const proj = projectDir(configDir(), local);
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(
      path.join(proj, `${sessionId}.jsonl`),
      JSON.stringify({ type: "user", cwd: local, sessionId, message: { role: "user", content: "cloudbound" } }) + "\n",
    );

    fs.writeFileSync(path.join(local, "tracked.txt"), "edited before leaving\n");
    fs.writeFileSync(path.join(local, "fresh.txt"), "brand new\n");

    const out = await beamOut({ device: cloud, remoteDir: remote, localDir: local, sessionId });
    assert.equal(out.ok, true, `beam out failed: ${out.error}`);
    assert.equal(out.carryRefused, undefined, `work was not carried: ${out.carryRefused}`);

    const head = (await run("git", ["-C", local, "rev-parse", "HEAD"])).stdout.trim();
    const there = await cloud.exec(`git -C ${JSON.stringify(remote)} rev-parse HEAD`);
    assert.equal(there.stdout.trim(), head, "the seeded box must stand on the same commit");

    const landed = await cloud.exec(`cat ${JSON.stringify(`${out.info.cfg}/projects/${slug(remote)}/${sessionId}.jsonl`)}`);
    assert.match(landed.stdout, /cloudbound/, "the transcript should have shipped");
    const carried = await cloud.exec(`cat ${JSON.stringify(`${remote}/tracked.txt`)} ${JSON.stringify(`${remote}/fresh.txt`)}`);
    assert.match(carried.stdout, /edited before leaving/);
    assert.match(carried.stdout, /brand new/);

    // Work happens out there, then comes home.
    await cloud.exec(`printf 'made in the cloud\\n' > ${JSON.stringify(`${remote}/cloud-only.txt`)}`);
    const back = await beamBack({
      device: cloud,
      remoteDir: remote,
      localDir: local,
      sessionId,
      home: out.info.home,
      cfg: out.info.cfg,
      departure: out.departure,
    });
    assert.equal(back.ok, true, `beam back failed: ${back.error}`);
    assert.equal(back.carryRefused, undefined, `work did not come back: ${back.carryRefused}`);
    assert.equal(fs.readFileSync(path.join(local, "cloud-only.txt"), "utf8"), "made in the cloud\n");
    assert.equal(fs.readFileSync(path.join(local, "tracked.txt"), "utf8"), "edited before leaving\n");
  });
});

test("C3: the launch command Claude Code is given actually starts over there", async () => {
  // Stops short of a full session, which would need the box signed in — but
  // proves the plugin landed and the binary runs with the flags we pass.
  await withCloud(async (cloud) => {
    const info = await checkDevice(cloud);
    const { remotePlugin } = await import("../src/move.mjs");
    const plugin = remotePlugin(info.home);
    const present = await cloud.exec(`test -f ${JSON.stringify(`${plugin}/.claude-plugin/plugin.json`)} && echo yes`);
    assert.equal(present.stdout.trim(), "yes", "the ccbeam plugin should have been shipped to the box");
    const runs = await cloud.exec(`command claude --plugin-dir ${JSON.stringify(plugin)} --version`);
    assert.match(runs.stdout, /Claude Code/, `claude did not run with our flags: ${runs.stderr}`);
  });
});

test("C4: a conversation living in the box can be listed, resumed and deleted", async () => {
  await withCloud(async (cloud) => {
    const { beamAdopt } = await import("../src/move.mjs");
    const { listSessions, removeSession } = await import("../src/cloud/sessions.mjs");

    // A conversation that exists only over there — the detached-session case.
    const id = `e2e${Date.now()}-aaaa-bbbb-cccc-dddddddddddd`;
    const dir = "/home/user/work/resume-me";
    const info = await checkDevice(cloud);
    const proj = `${info.cfg}/projects/${slug(dir)}`;
    const line = JSON.stringify({
      type: "user",
      cwd: dir,
      sessionId: id,
      message: { role: "user", content: "left running in the cloud" },
    });
    await cloud.exec(
      `mkdir -p ${JSON.stringify(proj)} ${JSON.stringify(dir)} && printf '%s\\n' ${JSON.stringify(line)} > ${JSON.stringify(`${proj}/${id}.jsonl`)}`,
    );

    const listed = await listSessions(cloud);
    const mine = listed.find((s) => s.id === id);
    assert.ok(mine, `the session should be listed: ${listed.map((s) => s.id).join(", ")}`);
    assert.equal(mine.cwd, dir);
    assert.match(mine.label, /left running in the cloud/, `label was "${mine.label}"`);

    // Adopting it must not ship our transcript or touch our repo.
    const adopted = await beamAdopt({ device: cloud, sessionId: id, remoteDir: dir });
    assert.equal(adopted.ok, true, `adopt failed: ${adopted.error}`);
    assert.equal(adopted.dir, dir);

    // Adopting something that isn't there must refuse rather than invent it.
    const ghost = await beamAdopt({ device: cloud, sessionId: "no-such-session-id", remoteDir: dir });
    assert.equal(ghost.ok, false);
    assert.match(ghost.error, /no longer on cloud/);

    const removed = await removeSession(cloud, id);
    assert.equal(removed.ok, true, removed.error);
    assert.equal((await listSessions(cloud)).some((s) => s.id === id), false, "it should be gone");
    // The folder it worked in is deliberately kept.
    const kept = await cloud.exec(`test -d ${JSON.stringify(dir)} && echo yes`);
    assert.equal(kept.stdout.trim(), "yes", "deleting a conversation must not delete anyone's files");
  });
});

// Part B needs a reachable machine. Without one, say so plainly rather than
// reporting failures that are really a missing test fixture.
const reachable = (await checkDevice(device)).ok;
if (!reachable) {
  process.stdout.write(`  ⚠ ${HOST} unreachable — skipping the ssh tests (set CCBEAM_HOST, see README)\n`);
}

const only = process.argv[2];
let skipped = 0;
for (const [name, fn] of tests) {
  if (only && !name.startsWith(only)) continue;
  if (!reachable && name.startsWith("B")) {
    skipped++;
    continue;
  }
  const started = Date.now();
  try {
    await fn();
    passed++;
    process.stdout.write(`  ✓ ${name} ${Math.round((Date.now() - started) / 1000)}s\n`);
  } catch (err) {
    process.stdout.write(`  ✕ ${name}\n    ${err.message.split("\n").slice(0, 12).join("\n    ")}\n`);
    process.exitCode = 1;
  }
}
const selected = tests.filter(([n]) => !only || n.startsWith(only)).length;
process.stdout.write(`\n  ${passed}/${selected - skipped} passed${skipped ? `, ${skipped} skipped` : ""}\n`);
