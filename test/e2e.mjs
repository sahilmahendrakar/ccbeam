#!/usr/bin/env node
/**
 * End-to-end tests.
 *
 * Part A drives the real supervisor with real Claude Code sessions and checks
 * that a conversation survives a move — the property the whole product rests on.
 * Part B drives the ssh machinery against a real sshd, checking that the
 * transcript and uncommitted work land where they should on the far side.
 *
 * Part B needs a reachable host; set CCT_HOST (default: cct-localhost).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { cleanEnv, run } from "../src/exec.mjs";
import { configDir, projectDir, slug } from "../src/paths.mjs";
import { checkMachine, teleportBack, teleportOut } from "../src/move.mjs";
import { sshExec } from "../src/ssh.mjs";

const HOST = process.env.CCT_HOST || "cct-localhost";
const BIN = path.resolve(new URL("../bin/ccteleport.mjs", import.meta.url).pathname);
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `cct-e2e-${tag}-`));

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
      env: cleanEnv({ CCTELEPORT_TEST_PROMPTS: JSON.stringify(prompts) }),
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
    `The codeword is ${codeword}. Now call the mcp__ccteleport__teleport tool with target "local:${to}".`,
    "What was the codeword mentioned earlier in this conversation? Reply with only that word.",
  ]);

  assert.match(out, new RegExp(codeword), `the moved session did not recall the codeword.\n${out}`);

  const landed = fs.readdirSync(projectDir(configDir(), to)).filter((f) => f.endsWith(".jsonl"));
  assert.equal(landed.length, 1, "exactly one session should have landed in the destination");
});

test("A2: the /teleport slash command drives a real move", async () => {
  const from = tmp("cmd-from");
  const to = tmp("cmd-to");

  // Plugin commands are namespaced. Interactively `/teleport` resolves when
  // unambiguous; in print mode the full form is required.
  const { out } = await supervise(from, [`/ccteleport:teleport local:${to}`, "Reply with only the word ARRIVED."]);

  assert.match(out, /ARRIVED/, `the session did not run in the destination.\n${out}`);
  assert.ok(
    fs.existsSync(projectDir(configDir(), to)),
    "the slash command should have moved the session into the destination folder",
  );
});

// ---------------------------------------------------------------- Part B ----

test("B1: the machine reports itself ready", async () => {
  const info = await checkMachine(HOST);
  assert.equal(info.ok, true, `could not reach ${HOST}: ${info.error}`);
  assert.deepEqual(info.missing, [], `${HOST} is missing tools: ${info.missing?.join(", ")}`);
  assert.ok(info.cfg, "should report where Claude Code keeps state on that machine");
});

test("B2: teleporting out ships the transcript and carries uncommitted work", async () => {
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

  const result = await teleportOut({ host: HOST, remoteDir: remote, localDir: local, sessionId });
  assert.equal(result.ok, true, `teleport failed: ${result.error}`);
  assert.equal(result.carryRefused, undefined, `work was not carried: ${result.carryRefused}`);
  assert.ok(result.carried, "should report carrying work");

  const landedAt = `${result.info.cfg}/projects/${slug(remote)}/${sessionId}.jsonl`;
  const check = await sshExec(HOST, `cat ${JSON.stringify(landedAt)}`);
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
  const out = await teleportOut({ host: HOST, remoteDir: remote, localDir: local, sessionId });
  assert.equal(out.ok, true, `teleport out failed: ${out.error}`);

  // Work happens out there: the transcript grows and a file is created.
  const remoteProj = `${out.info.cfg}/projects/${slug(remote)}`;
  await sshExec(
    HOST,
    `printf '%s\\n' ${JSON.stringify(JSON.stringify({ type: "assistant", sessionId, message: { role: "assistant", content: "worked remotely" } }))} >> ${JSON.stringify(`${remoteProj}/${sessionId}.jsonl`)}`,
  );
  fs.writeFileSync(path.join(remote, "server-only.txt"), "made on the server\n");

  const back = await teleportBack({
    host: HOST,
    remoteDir: remote,
    localDir: local,
    sessionId,
    home: out.info.home,
    cfg: out.info.cfg,
    departure: out.departure,
  });
  assert.equal(back.ok, true, `teleport back failed: ${back.error}`);
  assert.equal(back.carryRefused, undefined, `work did not come back: ${back.carryRefused}`);

  const transcript = fs.readFileSync(path.join(proj, `${sessionId}.jsonl`), "utf8");
  assert.match(transcript, /worked remotely/, "the remote half of the conversation should have come home");
  assert.equal(fs.readFileSync(path.join(local, "server-only.txt"), "utf8"), "made on the server\n");
  assert.equal(fs.readFileSync(path.join(local, "tracked.txt"), "utf8"), "written on the laptop\n");
});

// Part B needs a reachable machine. Without one, say so plainly rather than
// reporting failures that are really a missing test fixture.
const reachable = (await checkMachine(HOST)).ok;
if (!reachable) {
  process.stdout.write(`  ⚠ ${HOST} unreachable — skipping the ssh tests (set CCT_HOST, see README)\n`);
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
