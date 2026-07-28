import fs from "node:fs";
import path from "node:path";
import { run } from "./exec.mjs";
import { configDir, projectDir } from "./paths.mjs";
import { sshExec } from "./ssh.mjs";

/**
 * The picker's menu is Claude Code's own history: every directory you have
 * ever run it in, on that machine, newest first. No configuration, no
 * registry to maintain — if you have worked somewhere, it is on the list.
 *
 * The real path comes from the `cwd` field recorded inside each transcript,
 * never from the directory slug, which cannot be reversed unambiguously.
 */
// Note: no `${` anywhere below — this is a JS template literal, so shell
// parameter expansion of that form would be swallowed by JavaScript.
const LIST_SCRIPT = String.raw`
CFG="$CLAUDE_CONFIG_DIR"; [ -n "$CFG" ] || CFG="$HOME/.claude"
for d in "$CFG"/projects/*/; do
  [ -d "$d" ] || continue
  f=$(ls -t "$d"*.jsonl 2>/dev/null | head -1)
  [ -n "$f" ] || continue
  cwd=$(head -40 "$f" | grep -o '"cwd":"[^"]*"' | head -1 | cut -d'"' -f4)
  [ -n "$cwd" ] || continue
  [ -d "$cwd" ] || continue
  ts=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0)
  br=""; dirty=0
  if git -C "$cwd" rev-parse --git-dir >/dev/null 2>&1; then
    br=$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null)
    dirty=$(git -C "$cwd" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  fi
  printf '%s\t%s\t%s\t%s\n' "$ts" "$cwd" "$br" "$dirty"
done | sort -rn
`;

function parse(tsv) {
  const seen = new Set();
  const out = [];
  for (const line of tsv.split("\n")) {
    const [ts, dir, branch, dirty] = line.split("\t");
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    out.push({
      dir,
      at: Number(ts) * 1000 || 0,
      branch: branch || null,
      dirty: Number(dirty) || 0,
    });
  }
  return out;
}

export async function listRemote(host) {
  const r = await sshExec(host, LIST_SCRIPT, { timeout: 25000 });
  if (r.code !== 0) return [];
  return parse(r.stdout);
}

/** The same listing for this machine, without the ssh leg. */
export async function listLocal() {
  const cfg = configDir();
  const root = path.join(cfg, "projects");
  const rows = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  for (const slugName of entries) {
    const dir = path.join(root, slugName);
    let newest = null;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const st = fs.statSync(path.join(dir, f));
        if (!newest || st.mtimeMs > newest.mtimeMs) newest = { file: path.join(dir, f), mtimeMs: st.mtimeMs };
      }
    } catch {
      continue;
    }
    if (!newest) continue;
    const cwd = readCwd(newest.file);
    if (!cwd || !fs.existsSync(cwd)) continue;
    rows.push({ ts: Math.floor(newest.mtimeMs / 1000), cwd });
  }
  rows.sort((a, b) => b.ts - a.ts);

  const out = [];
  const seen = new Set();
  for (const { ts, cwd } of rows) {
    if (seen.has(cwd)) continue;
    seen.add(cwd);
    out.push({ dir: cwd, at: ts * 1000, ...(await gitState(cwd)) });
  }
  return out;
}

/** Read the first `cwd` recorded in a transcript. */
function readCwd(file) {
  let head;
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    head = buf.subarray(0, n).toString("utf8");
  } catch {
    return null;
  }
  return head.match(/"cwd":"((?:[^"\\]|\\.)*)"/)?.[1]?.replace(/\\(.)/g, "$1") ?? null;
}

export async function gitState(dir) {
  const inRepo = await run("git", ["-C", dir, "rev-parse", "--git-dir"]);
  if (inRepo.code !== 0) return { branch: null, dirty: 0 };
  const branch = await run("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
  const status = await run("git", ["-C", dir, "status", "--porcelain"]);
  return {
    branch: branch.stdout.trim() || null,
    dirty: status.stdout.split("\n").filter((l) => l.trim()).length,
  };
}

/** Does this directory exist on the far side? */
export async function remoteDirExists(host, dir) {
  const r = await sshExec(host, `test -d ${JSON.stringify(dir)} && echo yes || echo no`);
  return r.stdout.trim() === "yes";
}

export { projectDir };
