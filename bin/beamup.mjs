#!/usr/bin/env node
/**
 * beamup — move a Claude Code session between devices.
 *
 * This is a supervisor, not a client. It launches the real `claude` and hands
 * it the terminal; when a session asks to move, it ships the transcript and any
 * uncommitted work to the destination and launches the real `claude` there. The
 * conversation is continuous because it is literally the same session file.
 *
 * A "device" is a machine you can ssh to, or a cloud sandbox rented by the
 * second. The supervisor cannot tell them apart: both take bash and copy
 * directories, and everything provider-shaped lives behind src/device/.
 */
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { runInherit, run } from "../src/exec.mjs";
import { configDir, lastDirOn, newestSession, recordVisit, stateDir } from "../src/paths.mjs";
import { CLOUD, LOCAL, cloudWorkDir, describeState, devices } from "../src/devices.mjs";
import { getDevice } from "../src/device/index.mjs";
import { apiKey, isConfigured, patchCloud, readCloud, saveApiKey } from "../src/cloud/config.mjs";
import { repairAuth, setupCloud } from "../src/cloud/setup.mjs";
import { listLocal, listRemote } from "../src/folders.mjs";
import { clearRequest, parseTarget, readRequest } from "../src/request.mjs";
import {
  beamBack,
  beamLocal,
  beamOut,
  checkDevice,
  describeMissing,
  localPluginDir,
  remotePlugin,
  remoteRequestFile,
} from "../src/move.mjs";
import { pick } from "../src/picker.mjs";
import { askSecret } from "../src/prompt.mjs";
import { SHELLS, detectShell, install as installShell, uninstall as uninstallShell } from "../src/shell.mjs";
import { banner, bold, dim, fail, green, note, relTime, tilde, warn, yellow } from "../src/ui.mjs";

const HELP = `
${bold("beamup")} — move a Claude Code session between devices

  beamup [claude options...]     start a session you can beam out of
  beamup devices                 list devices and what they are doing
  beamup doctor [device]         check whether a device is ready
  beamup cloud [key|auth|repair|destroy]
                                 set up or manage the cloud box
  beamup install-shell           make \`claude\` beam-capable
  beamup uninstall-shell         undo that

Inside the session:
  /beam                          pick a device, then a folder
  /beam gpu-box[:~/src]          go straight there
  /beam cloud                    go to your cloud box
  /beam home                     return to where this session started

Devices come from your ~/.ssh/config — there is nothing to install or run on
the far side beyond Claude Code, node and git. \`cloud\` is a sandbox on your
own E2B account; beamup runs no infrastructure and holds no keys.
`;

// Test-only: drives each leg with `claude -p <prompt>` instead of an
// interactive session, so the whole move can be exercised without a terminal.
const TEST_PROMPTS = process.env.BEAMUP_TEST_PROMPTS ? JSON.parse(process.env.BEAMUP_TEST_PROMPTS) : null;
let leg = 0;

async function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === "doctor") return doctor(argv[1]);
  if (argv[0] === "devices") return listDevices();
  if (argv[0] === "cloud") return cloudCommand(argv.slice(1));
  if (argv[0] === "install-shell") return shellIntegration(argv, true);
  if (argv[0] === "uninstall-shell") return shellIntegration(argv, false);
  if (argv.includes("--help") && argv.length === 1) {
    process.stdout.write(HELP);
    return 0;
  }

  const origin = { device: LOCAL, dir: process.cwd() };
  let cur = { device: LOCAL, dir: process.cwd(), sessionId: null, home: null, cfg: null, handle: null };
  let departure = null;
  const userArgs = argv;
  const bringsOwnSession = userArgs.some((a) =>
    ["--resume", "-r", "--continue", "-c", "--session-id", "--from-pr"].includes(a),
  );

  // A device that bills by the second must never outlive us, however we leave.
  const shutdown = async () => {
    await releasePendingWake();
    const handle = cur.handle;
    cur.handle = null;
    if (!handle) return;
    const released = await handle.release().catch(() => null);
    if (released?.note) note(released.note);
    if (released?.warn) warn(released.warn);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      shutdown().finally(() => process.exit(130));
    });
  }

  try {
    for (;;) {
      const local = cur.device === LOCAL;
      const reqFile = local ? path.join(stateDir(), `req-${process.pid}.json`) : remoteRequestFile(cur.home);

      if (local) clearRequest(reqFile);
      else await cur.handle.exec(`rm -f ${sh(reqFile)}`);

      banner(cur.device, cur.dir, { local, cloud: cur.device === CLOUD });
      const code = local
        ? await launchLocal(cur, userArgs, bringsOwnSession, reqFile)
        : await launchRemote(cur, reqFile);

      // Whatever session actually ran here is the one that moves next.
      cur.sessionId = local
        ? (newestSession(configDir(), cur.dir) ?? cur.sessionId)
        : ((await remoteNewestSession(cur)) ?? cur.sessionId);

      const req = local
        ? readRequest(reqFile)
        : parseJson((await cur.handle.exec(`cat ${sh(reqFile)} 2>/dev/null || true`)).stdout.trim());
      if (local) clearRequest(reqFile);
      else await cur.handle.exec(`rm -f ${sh(reqFile)}`);

      if (!req) return code === -1 ? 1 : code;

      const dest = await resolveDestination(req, cur, origin);
      if (!dest) {
        await releasePendingWake();
        note("staying put");
        continue;
      }

      const moved = await performMove(cur, dest, { departure });
      if (!moved.ok) {
        fail(moved.error ?? "the move failed");
        warn(`staying on ${cur.device === LOCAL ? "this machine" : cur.device}`);
        continue;
      }
      departure = moved.departure ?? null;
      cur = moved.next;
      recordVisit(cur.device, cur.dir);
    }
  } finally {
    await shutdown();
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

  return runInherit("claude", args, { cwd: cur.dir, env: { BEAMUP_REQ: reqFile } });
}

async function launchRemote(cur, reqFile) {
  const parts = [
    `cd ${sh(cur.dir)}`,
    // `command` so a shell function or alias named `claude` on the far device
    // resolves to the real binary. Without it, shell integration on both ends
    // would make the remote launch recurse into another supervisor.
    `BEAMUP_REQ=${sh(reqFile)} command claude --plugin-dir ${sh(remotePlugin(cur.home))} --resume ${sh(cur.sessionId)}`,
  ];
  if (TEST_PROMPTS) {
    parts[1] += ` -p ${sh(TEST_PROMPTS[leg++] ?? "ok")} --permission-mode bypassPermissions`;
    const r = await cur.handle.exec(parts.join(" && "), { timeout: 300000 });
    process.stdout.write(r.stdout);
    if (r.code !== 0) process.stdout.write(r.stderr);
    return r.code;
  }
  return cur.handle.attach(parts.join(" && "));
}

async function remoteNewestSession(cur) {
  const r = await cur.handle.exec(`ls -t ${sh(`${cur.cfg}/projects`)}/*/*.jsonl 2>/dev/null | head -1`);
  const file = r.stdout.trim();
  return file ? path.basename(file, ".jsonl") : null;
}

/** Turn a request into a concrete device + directory, asking if needed. */
async function resolveDestination(req, cur, origin) {
  let { device, dir, home } = parseTarget(req.target);
  if (req.action === "back" || home) return { device: origin.device, dir: origin.dir };

  if (!device) {
    const rows = devices(cur.device);
    const chosen = await pick({
      title: bold("  beam to"),
      rows,
      preselect: Math.max(0, rows.findIndex((r) => !r.isCurrent)),
      render: (r) => ({
        text: `${r.isLocal ? "⌂" : r.isCloud ? "☁" : " "} ${r.name.padEnd(18)} ${dim(
          describeState(r) || (r.lastSeen ? relTime(r.lastSeen) : ""),
        )}`,
      }),
    });
    if (!chosen) {
      await releasePendingWake();
      return null;
    }
    device = chosen.name;
  }

  if (!dir) {
    const rows = device === LOCAL ? await listLocal() : await listRemoteOn(device);
    if (!rows.length) {
      // A cloud box on its first visit has no history to offer, and exactly one
      // sensible answer — the repo you are standing in. Asking would be theatre.
      if (device === CLOUD) return { device, dir: cloudWorkDir(cur.dir) };
      fail(`no folders known on ${device} — pass one explicitly, e.g. /beam ${device}:~/src`);
      return null;
    }
    const last = lastDirOn(device);
    const chosen = await pick({
      title: bold(`  ${device} — folder`),
      rows,
      preselect: Math.max(0, rows.findIndex((r) => r.dir === last)),
      render: (r) => ({
        text: `${tilde(r.dir).padEnd(42)} ${dim(
          [r.branch, r.dirty ? `·${r.dirty} dirty` : ""].filter(Boolean).join(" "),
        )}`,
      }),
    });
    if (!chosen) {
      await releasePendingWake();
      return null;
    }
    dir = chosen.dir;
  }

  return { device, dir: await expandDir(device, dir) };
}

/**
 * A device we woke only to read its folder list.
 *
 * Waking a box that bills by the second to answer a question you then cancel is
 * exactly the kind of silent cost this tool refuses to create — so the handle is
 * held here until we know whether we're going there. If we are, performMove
 * reuses it (no second connect); if we're not, it gets paused.
 */
let pendingWake = null;

async function releasePendingWake() {
  const handle = pendingWake;
  pendingWake = null;
  if (!handle) return;
  const released = await handle.release().catch(() => null);
  if (released?.note) note(released.note);
  if (released?.warn) warn(released.warn);
}

/** Folder listing needs a live connection, which for cloud means waking it. */
async function listRemoteOn(name) {
  let handle;
  try {
    handle = await getDevice(name);
  } catch {
    return [];
  }
  const up = await handle.ensureUp({ onProgress: note });
  // Not fatal: the caller falls back to the cloud default or an explicit folder.
  if (!up.ok) return [];
  pendingWake = handle;
  return listRemote(handle);
}

/**
 * `~` means the far device's home, not ours. Resolved by asking that device,
 * never by string-substituting our own path.
 */
async function expandDir(name, dir) {
  if (!dir.startsWith("~")) return dir;
  const rest = dir.slice(1).replace(/^\//, "");
  if (name === LOCAL) return path.join(os.homedir(), rest);
  // The cloud box's home is fixed by its image; anything else gets asked.
  if (name === CLOUD) return path.posix.join("/home/user", rest);

  const handle = await getDevice(name);
  const r = await handle.exec('printf "%s" "$HOME"');
  const home = r.stdout.trim();
  await handle.dispose();
  return home ? path.posix.join(home, rest) : dir;
}

async function performMove(cur, dest, { departure }) {
  const sameDevice = dest.device === cur.device;

  // Hopping straight between two remote devices goes via home, so there is
  // only ever one path out and one path back to keep correct.
  if (!sameDevice && cur.device !== LOCAL && dest.device !== LOCAL) {
    const home = await performMove(cur, { device: LOCAL, dir: process.cwd() }, { departure });
    if (!home.ok) return home;
    return performMove(home.next, dest, { departure: home.departure });
  }

  if (sameDevice && dest.dir === cur.dir) return { ok: true, next: cur, departure };

  if (cur.device === LOCAL && dest.device === LOCAL) {
    note(`moving to ${tilde(dest.dir)}`);
    await beamLocal({ fromDir: cur.dir, toDir: dest.dir, sessionId: cur.sessionId });
    return { ok: true, next: { ...cur, dir: dest.dir }, departure };
  }

  if (cur.device === LOCAL) {
    // The cloud's one-time setup happens here, in the gap between sessions
    // where we own the terminal and can actually ask a question.
    if (dest.device === CLOUD && !isConfigured()) {
      const setup = await setupCloud();
      if (!setup.ok) return { ok: false, error: setup.error };
    }

    let handle = pendingWake?.name === dest.device ? pendingWake : null;
    if (handle) pendingWake = null;
    else {
      await releasePendingWake();
      handle = await getDevice(dest.device);
    }
    note(dest.device === CLOUD ? "waking the cloud box" : `beaming to ${dest.device}`);
    const out = await beamOut({
      device: handle,
      remoteDir: dest.dir,
      localDir: cur.dir,
      sessionId: cur.sessionId,
    });
    if (!out.ok) {
      const released = await handle.release().catch(() => null);
      if (released?.note) note(released.note);
      return out;
    }
    if (out.carried) note(`carried ${out.carried.files} changed file(s)`);
    if (out.carryRefused) warn(`did not carry your changes: ${out.carryRefused}`);
    return {
      ok: true,
      departure: out.departure,
      next: {
        device: dest.device,
        dir: dest.dir,
        sessionId: cur.sessionId,
        home: out.info.home,
        cfg: out.info.cfg,
        handle,
      },
    };
  }

  note(`returning to ${tilde(dest.dir)}`);
  const back = await beamBack({
    device: cur.handle,
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

  const released = await cur.handle.release().catch(() => null);
  if (released?.note) note(released.note);
  if (released?.warn) warn(released.warn);
  await cur.handle.dispose();

  return {
    ok: true,
    departure: null,
    next: { device: LOCAL, dir: dest.dir, sessionId: cur.sessionId, home: null, cfg: null, handle: null },
  };
}

/** `beamup cloud [key|auth|repair|destroy]` */
async function cloudCommand(args) {
  const sub = args[0];

  if (sub === "key") {
    const key = await askSecret("E2B API key:");
    if (!key) {
      fail("no key given");
      return 1;
    }
    saveApiKey(key);
    process.stdout.write(`  ${green("✓")} saved to ~/.beamup/config.json\n`);
    return 0;
  }

  if (sub === "destroy") {
    const stored = readCloud();
    if (!stored?.sandboxId) {
      note("there is no cloud box to destroy");
      return 0;
    }
    const handle = await getDevice(CLOUD);
    const loaded = await handle.sdk();
    if (!loaded.ok) {
      fail(loaded.error);
      return 1;
    }
    try {
      await loaded.e2b.Sandbox.kill(stored.sandboxId, { apiKey: apiKey() });
    } catch (err) {
      warn(`E2B did not confirm the kill: ${err?.message ?? err}`);
    }
    patchCloud({ sandboxId: null, provisioned: false });
    process.stdout.write(`  ${green("✓")} cloud box destroyed\n`);
    return 0;
  }

  if (sub === "auth") {
    const result = await repairAuth();
    return result.ok ? 0 : 1;
  }

  const result = await setupCloud({ recreate: sub === "repair" });
  if (!result.ok) {
    if (!result.partial) fail(result.error);
    return 1;
  }
  if (result.device) {
    const released = await result.device.release();
    if (released?.note) note(released.note);
  }
  process.stdout.write(`\n  ${green("ready")} — \`/beam cloud\` from any session\n`);
  return 0;
}

/**
 * `beamup install-shell` — so the command you type stays `claude`.
 * The supervisor still runs; it just stops being something you have to remember.
 */
function shellIntegration(argv, adding) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1];
  };
  const shell = flag("--shell") || detectShell();
  if (!shell) {
    fail(`could not tell which shell you use (SHELL=${process.env.SHELL || "unset"})`);
    note(`pass one explicitly:  beamup ${adding ? "install-shell" : "uninstall-shell"} --shell zsh`);
    note(`supported: ${SHELLS.join(", ")}`);
    return 1;
  }

  const result = adding ? installShell({ shell, rcFile: flag("--rc") }) : uninstallShell({ shell, rcFile: flag("--rc") });

  if (!result.ok) {
    fail(result.error);
    return 1;
  }

  switch (result.action) {
    case "installed":
      process.stdout.write(`  ${green("✓")} added the ${shell} integration to ${result.file}\n`);
      if (result.backup) note(`backed the file up to ${result.backup} first`);
      if (result.conflict) warn("something else in that file already defines `claude` — ours must load last to win");
      note(`open a new terminal (or: source ${result.file}) and \`claude\` becomes beam-capable`);
      note("`command claude` still runs Claude Code directly");
      break;
    case "already":
      note(`already installed in ${result.file}`);
      break;
    case "removed":
      process.stdout.write(`  ${green("✓")} removed the ${shell} integration from ${result.file}\n`);
      note("open a new terminal for it to take effect");
      break;
    case "absent":
      note(`nothing to remove in ${result.file}`);
      break;
  }
  return 0;
}

async function doctor(name) {
  if (!name) {
    process.stdout.write(`${bold("local")}\n`);
    const v = await run("claude", ["--version"]);
    process.stdout.write(`  claude   ${v.stdout.trim() || yellow("not found")}\n`);
    process.stdout.write(`  config   ${configDir()}\n`);
    return 0;
  }
  process.stdout.write(`${bold(name)}\n`);

  let handle;
  try {
    handle = await getDevice(name);
  } catch (err) {
    fail(String(err.message ?? err));
    return 1;
  }

  const up = await handle.ensureUp({ onProgress: note });
  if (!up.ok) {
    process.stdout.write(`  ${yellow("unavailable")} — ${up.error}\n`);
    return 1;
  }

  const info = await checkDevice(handle);
  if (!info.ok) {
    process.stdout.write(`  ${yellow("unreachable")} — ${info.error}\n`);
    await handle.release();
    return 1;
  }
  process.stdout.write(`  claude   ${info.version || yellow("not found")}\n`);
  process.stdout.write(`  node     ${info.node || yellow("not found")}\n`);
  process.stdout.write(`  git      ${info.git || yellow("not found")}\n`);
  process.stdout.write(`  config   ${info.cfg}\n`);

  const missing = info.missing.length;
  if (missing) process.stdout.write(`\n${describeMissing(handle, info.missing)}\n`);
  else process.stdout.write(`\n  ${green("ready")}\n`);

  const released = await handle.release();
  if (released?.note) note(released.note);
  return missing ? 1 : 0;
}

async function listDevices() {
  // Asking E2B costs a round trip, so only do it if there is a box to ask about.
  let cloudState = null;
  if (isConfigured()) {
    const handle = await getDevice(CLOUD);
    cloudState = await handle.state().catch(() => null);
    await handle.dispose();
  }

  const rows = devices(null, { cloudState });
  const online = await Promise.all(
    rows.map((r) =>
      r.isLocal
        ? true
        : r.isCloud
          ? cloudState !== null
          : getDevice(r.name)
              .then((d) => d.isOnline())
              .catch(() => false),
    ),
  );
  rows.forEach((r, i) => {
    const dot = r.isCloud && r.state === "paused" ? yellow("⏸") : online[i] ? green("●") : dim("○");
    const status = describeState(r) || (r.lastSeen ? relTime(r.lastSeen) : "");
    process.stdout.write(`  ${dot} ${r.name.padEnd(20)} ${dim(status)}\n`);
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
