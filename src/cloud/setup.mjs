/**
 * Standing up the cloud box, once.
 *
 * This is the only part of ccbeam with real setup, and it is deliberately the
 * only part: after this runs, `cloud` behaves exactly like `gpu-box` and you
 * never think about it again.
 *
 * The rule it exists to honour is the same one that governs every other device
 * — **ccbeam never carries your Claude credentials anywhere**. A machine you
 * ssh to signs itself in with `claude auth login`; so does the cloud box, in
 * its own PTY, and the sign-in survives because a paused sandbox keeps its
 * whole filesystem. The alternative — copying ~/.claude/.credentials.json off
 * your laptop — would be against Anthropic's terms and is not implemented
 * anywhere in this codebase on purpose.
 */
import { E2BDevice } from "../device/e2b.mjs";
import { BASE_TEMPLATE, apiKey, patchCloud, readCloud, saveApiKey } from "./config.mjs";
import { ask, askSecret, choose } from "../prompt.mjs";
import { bold, dim, fail, green, note, warn } from "../ui.mjs";

/**
 * Everything the box needs to be a Claude Code machine.
 *
 * Installed into the user's own npm prefix rather than with sudo, so this works
 * whatever the image's permissions look like, and re-run safe: each step checks
 * before it acts. It runs once — the paused snapshot keeps the result forever.
 */
export const PROVISION_SCRIPT = `
set -u
export PATH="$HOME/.npm-global/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "ccbeam: no node in this image" >&2
  exit 90
fi

if ! command -v git >/dev/null 2>&1; then
  (sudo apt-get update -qq && sudo apt-get install -y -qq git) >/dev/null 2>&1 || true
fi
if ! command -v git >/dev/null 2>&1; then
  echo "ccbeam: could not install git" >&2
  exit 91
fi

if ! command -v claude >/dev/null 2>&1; then
  mkdir -p "$HOME/.npm-global"
  npm config set prefix "$HOME/.npm-global" >/dev/null 2>&1
  npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 || {
    echo "ccbeam: npm could not install Claude Code" >&2
    exit 92
  }
fi

grep -q 'npm-global/bin' "$HOME/.bashrc" 2>/dev/null || \\
  echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> "$HOME/.bashrc"

command -v claude >/dev/null 2>&1 || { echo "ccbeam: claude still not on PATH" >&2; exit 93; }
echo "provisioned $(claude --version 2>/dev/null | head -1)"
`;

function describeProvisionFailure(code, stderr) {
  const last = (stderr || "").trim().split("\n").pop();
  switch (code) {
    case 90:
      return "that E2B template has no Node — pick an image with Node 18+ (`ccbeam cloud template <id>`)";
    case 91:
      return "could not install git in the box";
    case 92:
      return "npm could not install Claude Code in the box (no network egress?)";
    case 93:
      return "Claude Code installed but is not on PATH";
    default:
      return last || `provisioning exited ${code}`;
  }
}

/** Ask for, validate and store the E2B key. */
async function collectKey() {
  if (apiKey()) return { ok: true };

  process.stdout.write(
    [
      "",
      `  ${bold("The cloud box runs on your own E2B account.")}`,
      dim("  ccbeam operates no servers and holds no keys — your code goes from"),
      dim("  this machine to your sandbox, with nothing in between."),
      "",
      dim("  Get a key at https://e2b.dev/dashboard"),
      "",
    ].join("\n"),
  );

  const key = await askSecret("E2B API key:");
  if (!key) return { ok: false, error: "no key given" };
  saveApiKey(key);
  note("saved to ~/.ccbeam/config.json (mode 600)");
  return { ok: true };
}

/**
 * Sign the box in to Claude Code, its own way.
 * Returns the auth mode actually established.
 */
async function establishAuth(device) {
  const already = await device.exec(
    `export PATH="$HOME/.npm-global/bin:$PATH"; claude -p ok --max-turns 1 >/dev/null 2>&1 && echo yes || echo no`,
    { timeout: 120000 },
  );
  if (already.stdout.trim() === "yes") {
    note("the cloud box is already signed in");
    return { ok: true, mode: "existing" };
  }

  const option = await choose("The cloud box has to sign in to Claude Code itself", [
    {
      value: "signin",
      label: "Sign in with your Claude account",
      detail: "opens Claude Code in the box; sign in there, then exit. Survives pauses.",
    },
    {
      value: "apikey",
      label: "Use an Anthropic API key",
      detail: "billed as API usage, separately from your Claude subscription.",
    },
  ]);

  if (option.value === "apikey") {
    const key = await askSecret("ANTHROPIC_API_KEY:");
    if (!key) return { ok: false, error: "no key given" };
    // Written inside the box, not stored on this machine.
    const written = await device.exec(
      `mkdir -p "$HOME/.ccbeam" && printf '%s\\n' 'export ANTHROPIC_API_KEY=${shellSingle(key)}' > "$HOME/.ccbeam/env" && chmod 600 "$HOME/.ccbeam/env" && ` +
        `grep -q 'ccbeam/env' "$HOME/.bashrc" || echo '[ -f "$HOME/.ccbeam/env" ] && . "$HOME/.ccbeam/env"' >> "$HOME/.bashrc"`,
    );
    if (written.code !== 0) return { ok: false, error: `could not store the key in the box: ${written.stderr}` };
    patchCloud({ auth: "apikey" });
    return { ok: true, mode: "apikey" };
  }

  process.stdout.write(
    [
      "",
      dim("  The sign-in flow is about to open in the cloud box. Follow it there;"),
      dim("  it returns here on its own. Nothing is copied from this machine."),
      "",
      dim("  This is a sign-in, not a beam — there is no conversation and no"),
      dim("  /ccbeam:up in it. You get those when you beam in afterwards."),
      "",
    ].join("\n"),
  );
  await ask("press enter when ready");

  // `claude auth login` rather than a whole session: it does the one thing that
  // needs a terminal, then exits. Opening a bare `claude` here used to leave
  // people sitting in a plugin-less session in the box wondering where
  // /ccbeam:up went — a real confusion, and a fair one.
  await device.attach(`export PATH="$HOME/.npm-global/bin:$PATH"; cd "$HOME"; claude auth login`);

  const verified = await device.exec(
    `export PATH="$HOME/.npm-global/bin:$PATH"; claude -p ok --max-turns 1 >/dev/null 2>&1 && echo yes || echo no`,
    { timeout: 120000 },
  );
  if (verified.stdout.trim() !== "yes") {
    return { ok: false, error: "the box still is not signed in — run `ccbeam cloud auth` to try again" };
  }
  patchCloud({ auth: "signin" });
  return { ok: true, mode: "signin" };
}

/**
 * The whole first run. Idempotent: each step is skipped if it is already done,
 * so this doubles as `ccbeam cloud repair`.
 */
export async function setupCloud({ recreate = false } = {}) {
  const key = await collectKey();
  if (!key.ok) return key;

  const device = new E2BDevice();
  const stored = readCloud();

  if (recreate || !stored?.sandboxId) {
    if (recreate && stored?.sandboxId) note(`replacing the old box (${stored.sandboxId})`);
    note("starting the cloud box");
    const created = await device.create({
      template: stored?.template || BASE_TEMPLATE,
      onProgress: note,
    });
    if (!created.ok) return created;
    process.stdout.write(`  ${green("✓")} cloud is up (${created.sandboxId})\n`);
  } else {
    const up = await device.ensureUp({ onProgress: note });
    if (!up.ok) return up;
    process.stdout.write(`  ${green("✓")} cloud is up\n`);
  }

  note("installing Claude Code in the box (once, ~1 min)");
  const provisioned = await device.exec(PROVISION_SCRIPT, { timeout: 600000 });
  if (provisioned.code !== 0) {
    await device.release();
    return { ok: false, error: describeProvisionFailure(provisioned.code, provisioned.stderr) };
  }
  patchCloud({ provisioned: true });
  process.stdout.write(`  ${green("✓")} ${provisioned.stdout.trim().split("\n").pop() || "provisioned"}\n`);

  const auth = await establishAuth(device);
  if (!auth.ok) {
    warn(auth.error);
    warn("the box is set up but cannot run Claude Code yet — `ccbeam cloud auth` when you're ready");
    const paused = await device.release();
    if (paused?.note) note(paused.note);
    return { ok: false, error: auth.error, partial: true };
  }
  if (auth.mode !== "existing") process.stdout.write(`  ${green("✓")} signed in\n`);

  return { ok: true, device };
}

/** Just the sign-in step, for when the first attempt was abandoned. */
export async function repairAuth() {
  const device = new E2BDevice();
  const up = await device.ensureUp({ onProgress: note });
  if (!up.ok) return up;
  const auth = await establishAuth(device);
  const paused = await device.release();
  if (paused?.note) note(paused.note);
  if (!auth.ok) {
    fail(auth.error);
    return auth;
  }
  return { ok: true };
}

function shellSingle(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
