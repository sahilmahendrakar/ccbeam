#!/usr/bin/env node
/**
 * ccteleport — move a Claude Code session between machines.
 *
 * This is a supervisor, not a client. It launches the real `claude` and hands
 * it the terminal; when a session asks to move, it ships the transcript and any
 * uncommitted work to the destination and launches the real `claude` there. The
 * conversation is continuous because it is literally the same session file.
 */
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { runInherit, run } from "../src/exec.mjs";
import { configDir, lastDirOn, newestSession, recordVisit, stateDir } from "../src/paths.mjs";
import { LOCAL, machines } from "../src/machines.mjs";
import { listLocal, listRemote } from "../src/folders.mjs";
import { clearRequest, parseTarget, readRequest } from "../src/request.mjs";
import { checkMachine, describeMissing, localPluginDir, remotePlugin, remoteRequestFile, teleportBack, teleportLocal, teleportOut } from "../src/move.mjs";
import { pick } from "../src/picker.mjs";
import { readRemoteFile, removeRemoteFile, sshExec, sshInteractive, isOnline } from "../src/ssh.mjs";
import { banner, bold, dim, fail, green, note, relTime, tilde, warn, yellow } from "../src/ui.mjs";

const HELP = `
${bold("ccteleport")} — move a Claude Code session between machines

  ccteleport [claude options...]   start a session you can teleport out of
  ccteleport doctor [machine]      check whether a machine is ready
  ccteleport machines              list known machines

Inside the session:
  /teleport [machine[:folder]]     move this conversation somewhere else
  /back                            return to where it started

Machines come from your ~/.ssh/config — there is nothing to install or run on
the far side beyond Claude Code, node and git.
`;

// Test-only: drives each leg with `claude -p <prompt>` instead of an
// interactive session, so the whole move can be exercised without a terminal.
const TEST_PROMPTS = process.env.CCTELEPORT_TEST_PROMPTS
  ? JSON.parse(process.env.CCTELEPORT_TEST_PROMPTS)
  : null;
let leg = 0;

async function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === "doctor") return doctor(argv[1]);
  if (argv[0] === "machines") return listMachines();
  if (argv.includes("--help") && argv.length === 1) {
    process.stdout.write(HELP);
    return 0;
  }

  const origin = { machine: LOCAL, dir: process.cwd() };
  let cur = { machine: LOCAL, dir: process.cwd(), sessionId: null, home: null, cfg: null };
  let departure = null;
  const userArgs = argv;
  const bringsOwnSession = userArgs.some((a) =>
    ["--resume", "-r", "--continue", "-c", "--session-id", "--from-pr"].includes(a),
  );

  for (;;) {
    const local = cur.machine === LOCAL;
    const reqFile = local ? path.join(stateDir(), `req-${process.pid}.json`) : remoteRequestFile(cur.home);

    if (local) clearRequest(reqFile);
    else await removeRemoteFile(cur.machine, reqFile);

    banner(cur.machine, cur.dir, { local });
    const code = local ? await launchLocal(cur, userArgs, bringsOwnSession, reqFile) : await launchRemote(cur, reqFile);

    // Whatever session actually ran here is the one that moves next.
    cur.sessionId = local
      ? (newestSession(configDir(), cur.dir) ?? cur.sessionId)
      : (await remoteNewestSession(cur)) ?? cur.sessionId;

    const req = local ? readRequest(reqFile) : parseJson(await readRemoteFile(cur.machine, reqFile));
    if (local) clearRequest(reqFile);
    else await removeRemoteFile(cur.machine, reqFile);

    if (!req) return code === -1 ? 1 : code;

    const dest = await resolveDestination(req, cur, origin);
    if (!dest) {
      note("staying put");
      continue;
    }

    const moved = await performMove(cur, dest, { departure });
    if (!moved.ok) {
      fail(moved.error ?? "the move failed");
      warn(`staying on ${cur.machine === LOCAL ? "this machine" : cur.machine}`);
      continue;
    }
    departure = moved.departure ?? null;
    cur = moved.next;
    recordVisit(cur.machine, cur.dir);
  }
}

function launchLocal(cur, userArgs, bringsOwnSession, reqFile) {
  const args = [...userArgs, "--plugin-dir", localPluginDir()];
  if (cur.sessionId) args.push("--resume", cur.sessionId);
  else if (!bringsOwnSession) {
    cur.sessionId = randomUUID();
    args.push("--session-id", cur.sessionId);
  }
  if (TEST_PROMPTS) args.push("-p", TEST_PROMPTS[leg++] ?? "ok", "--permission-mode", "bypassPermissions");

  return runInherit("claude", args, { cwd: cur.dir, env: { CCTELEPORT_REQ: reqFile } });
}

async function launchRemote(cur, reqFile) {
  const parts = [
    `cd ${sh(cur.dir)}`,
    // `command` so a shell function or alias named `claude` on the far machine
    // resolves to the real binary. Without it, shell integration on both ends
    // would make the remote launch recurse into another supervisor.
    `CCTELEPORT_REQ=${sh(reqFile)} command claude --plugin-dir ${sh(remotePlugin(cur.home))} --resume ${sh(cur.sessionId)}`,
  ];
  if (TEST_PROMPTS) {
    parts[1] += ` -p ${sh(TEST_PROMPTS[leg++] ?? "ok")} --permission-mode bypassPermissions`;
    const r = await sshExec(cur.machine, parts.join(" && "), { timeout: 300000 });
    process.stdout.write(r.stdout);
    if (r.code !== 0) process.stdout.write(r.stderr);
    return r.code;
  }
  return sshInteractive(cur.machine, parts.join(" && "));
}

async function remoteNewestSession(cur) {
  const script = `ls -t ${sh(`${cur.cfg}/projects`)}/*/*.jsonl 2>/dev/null | head -1`;
  const r = await sshExec(cur.machine, script);
  const file = r.stdout.trim();
  return file ? path.basename(file, ".jsonl") : null;
}

/** Turn a request into a concrete machine + directory, asking if needed. */
async function resolveDestination(req, cur, origin) {
  if (req.action === "back") {
    return { machine: origin.machine, dir: origin.dir };
  }

  let { machine, dir } = parseTarget(req.target);

  if (!machine) {
    const rows = machines(cur.machine);
    const chosen = await pick({
      title: bold("  teleport to"),
      rows,
      preselect: rows.findIndex((r) => !r.isCurrent),
      render: (r) => ({
        text: `${r.isLocal ? "⌂" : " "} ${r.name.padEnd(18)} ${dim(
          r.isCurrent ? "you are here" : r.lastSeen ? relTime(r.lastSeen) : "",
        )}`,
      }),
    });
    if (!chosen) return null;
    machine = chosen.name;
  }

  if (!dir) {
    const rows = machine === LOCAL ? await listLocal() : await listRemote(machine);
    if (!rows.length) {
      fail(`no folders known on ${machine} — pass one explicitly, e.g. /teleport ${machine}:~/src`);
      return null;
    }
    const last = lastDirOn(machine);
    const chosen = await pick({
      title: bold(`  ${machine} — folder`),
      rows,
      preselect: Math.max(0, rows.findIndex((r) => r.dir === last)),
      render: (r) => ({
        text: `${tilde(r.dir).padEnd(42)} ${dim(
          [r.branch, r.dirty ? `·${r.dirty} dirty` : ""].filter(Boolean).join(" "),
        )}`,
      }),
    });
    if (!chosen) return null;
    dir = chosen.dir;
  }

  return { machine, dir: await expandDir(machine, dir) };
}

/**
 * `~` means the far machine's home, not ours. Resolved by asking that machine,
 * never by string-substituting our own path.
 */
async function expandDir(machine, dir) {
  if (!dir.startsWith("~")) return dir;
  if (machine === LOCAL) return path.join(os.homedir(), dir.slice(1).replace(/^\//, ""));
  const r = await sshExec(machine, 'printf "%s" "$HOME"');
  const home = r.stdout.trim();
  if (!home) return dir;
  return path.posix.join(home, dir.slice(1).replace(/^\//, ""));
}

async function performMove(cur, dest, { departure }) {
  const sameMachine = dest.machine === cur.machine;

  // Hopping straight between two remote machines goes via home, so there is
  // only ever one path out and one path back to keep correct.
  if (!sameMachine && cur.machine !== LOCAL && dest.machine !== LOCAL) {
    // ccteleport was launched here, so this is where "home" is.
    const home = await performMove(cur, { machine: LOCAL, dir: process.cwd() }, { departure });
    if (!home.ok) return home;
    return performMove(home.next, dest, { departure: home.departure });
  }

  if (sameMachine && dest.dir === cur.dir) return { ok: true, next: cur, departure };

  if (cur.machine === LOCAL && dest.machine === LOCAL) {
    note(`moving to ${tilde(dest.dir)}`);
    await teleportLocal({ fromDir: cur.dir, toDir: dest.dir, sessionId: cur.sessionId });
    return { ok: true, next: { ...cur, dir: dest.dir }, departure };
  }

  if (cur.machine === LOCAL) {
    note(`teleporting to ${dest.machine}`);
    const out = await teleportOut({
      host: dest.machine,
      remoteDir: dest.dir,
      localDir: cur.dir,
      sessionId: cur.sessionId,
    });
    if (!out.ok) return out;
    if (out.carried) note(`carried ${out.carried.files} changed file(s)`);
    if (out.carryRefused) warn(`did not carry your changes: ${out.carryRefused}`);
    return {
      ok: true,
      departure: out.departure,
      next: {
        machine: dest.machine,
        dir: dest.dir,
        sessionId: cur.sessionId,
        home: out.info.home,
        cfg: out.info.cfg,
      },
    };
  }

  note(`returning to ${tilde(dest.dir)}`);
  const back = await teleportBack({
    host: cur.machine,
    remoteDir: cur.dir,
    localDir: dest.dir,
    sessionId: cur.sessionId,
    home: cur.home,
    cfg: cur.cfg,
    departure,
  });
  if (!back.ok) return back;
  if (back.carried) note(`brought back ${back.carried.files} changed file(s)`);
  if (back.carryRefused) warn(back.carryRefused);
  return { ok: true, departure: null, next: { machine: LOCAL, dir: dest.dir, sessionId: cur.sessionId, home: null, cfg: null } };
}

async function doctor(host) {
  if (!host) {
    process.stdout.write(`${bold("local")}\n`);
    const v = await run("claude", ["--version"]);
    process.stdout.write(`  claude   ${v.stdout.trim() || yellow("not found")}\n`);
    process.stdout.write(`  config   ${configDir()}\n`);
    return 0;
  }
  process.stdout.write(`${bold(host)}\n`);
  const info = await checkMachine(host);
  if (!info.ok) {
    process.stdout.write(`  ${yellow("unreachable")} — ${info.error}\n`);
    return 1;
  }
  process.stdout.write(`  claude   ${info.version || yellow("not found")}\n`);
  process.stdout.write(`  node     ${info.node || yellow("not found")}\n`);
  process.stdout.write(`  git      ${info.git || yellow("not found")}\n`);
  process.stdout.write(`  config   ${info.cfg}\n`);
  if (info.missing.length) {
    process.stdout.write(`\n${describeMissing(host, info.missing)}\n`);
    return 1;
  }
  process.stdout.write(`\n  ${green("ready")}\n`);
  return 0;
}

async function listMachines() {
  const rows = machines();
  const online = await Promise.all(rows.map((r) => (r.isLocal ? true : isOnline(r.name))));
  rows.forEach((r, i) => {
    const dot = online[i] ? green("●") : dim("○");
    process.stdout.write(`  ${dot} ${r.name.padEnd(20)} ${dim(r.lastSeen ? relTime(r.lastSeen) : "")}\n`);
  });
  return 0;
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** Quote for a remote shell. */
function sh(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    fail(err?.stack || String(err));
    process.exit(1);
  });
