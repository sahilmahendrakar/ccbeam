/**
 * The conversations living on a device.
 *
 * `/beam cloud` means *this* conversation moves there — the session id is
 * preserved, which is the whole reason context survives. Picking up a
 * *different* conversation is a genuinely different act, so it gets a
 * different verb (`/beam cloud resume`) and its own list. Conflating the two
 * would let `/beam` silently abandon the conversation you were in.
 *
 * Sessions are read out of the device's own Claude Code state, the same way
 * folders are — there is no registry, and beamup records nothing about them.
 */
import { q } from "../exec.mjs";

/** Sessions untouched for this long are pruned on connect. */
export const DEFAULT_PRUNE_DAYS = 30;

// No `${` anywhere below — this is a JS template literal, so shell parameter
// expansion of that form would be swallowed by JavaScript.
const LIST_SCRIPT = String.raw`
CFG="$CLAUDE_CONFIG_DIR"; [ -n "$CFG" ] || CFG="$HOME/.claude"
for f in "$CFG"/projects/*/*.jsonl; do
  [ -f "$f" ] || continue
  id=$(basename "$f" .jsonl)
  cwd=$(head -40 "$f" | grep -o '"cwd":"[^"]*"' | head -1 | cut -d'"' -f4)
  [ -n "$cwd" ] || continue
  ts=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0)
  bytes=$(wc -c < "$f" 2>/dev/null | tr -d ' ')
  turns=$(grep -c '"type":"user"' "$f" 2>/dev/null || echo 0)
  label=$(grep -o '"role":"user","content":"[^"]\{1,90\}' "$f" | head -1 | sed 's/.*"content":"//')
  live=no
  pgrep -f "resume $id" >/dev/null 2>&1 && live=yes
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$ts" "$id" "$cwd" "$bytes" "$turns" "$live" "$label"
done | sort -rn
`;

function parse(tsv) {
  const out = [];
  for (const line of tsv.split("\n")) {
    const [ts, id, cwd, bytes, turns, live, ...rest] = line.split("\t");
    if (!id || !cwd) continue;
    out.push({
      id,
      cwd,
      at: Number(ts) * 1000 || 0,
      bytes: Number(bytes) || 0,
      turns: Number(turns) || 0,
      live: live === "yes",
      label: cleanLabel(rest.join("\t")),
    });
  }
  return out;
}

/** The first thing you said, as a handle for recognising the conversation. */
function cleanLabel(raw) {
  const text = (raw ?? "")
    .replace(/\\[nrt]/g, " ")
    .replace(/\\u[0-9a-fA-F]{4}/g, "")
    .replace(/\\(.)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 68 ? `${text.slice(0, 67)}…` : text;
}

export async function listSessions(device) {
  const r = await device.exec(LIST_SCRIPT, { timeout: 30000 });
  if (r.code !== 0) return [];
  return parse(r.stdout);
}

/**
 * Delete a session's transcript. The working folder is left alone — it may
 * hold work, and beamup does not delete anyone's files without being asked.
 */
export async function removeSession(device, id) {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return { ok: false, error: `not a session id: ${id}` };
  // Every copy, not just the first. One session id can appear under several
  // project folders — that is what a conversation which has moved around looks
  // like on disk, and "delete this conversation" means all of it.
  const r = await device.exec(
    `CFG="$CLAUDE_CONFIG_DIR"; [ -n "$CFG" ] || CFG="$HOME/.claude"; ` +
      `n=0; for f in "$CFG"/projects/*/${q(id)}.jsonl; do [ -f "$f" ] || continue; rm -f "$f" && n=$((n+1)); done; echo "$n"`,
  );
  const removed = Number(r.stdout.trim());
  if (!Number.isFinite(removed) || removed === 0) {
    return { ok: false, error: `no session ${id} on ${device.name}` };
  }
  return { ok: true, removed };
}

/**
 * Drop transcripts nobody has touched in a long time.
 *
 * A cloud box accumulates conversations you will never open again, and an
 * unbounded list is its own kind of mess. Announced when it happens — deleting
 * history silently would be worse than not deleting it at all.
 */
export async function pruneSessions(device, { days = DEFAULT_PRUNE_DAYS } = {}) {
  if (!Number.isFinite(days) || days <= 0) return { pruned: 0 };
  const r = await device.exec(
    `CFG="$CLAUDE_CONFIG_DIR"; [ -n "$CFG" ] || CFG="$HOME/.claude"; ` +
      `find "$CFG/projects" -name '*.jsonl' -type f -mtime +${Math.floor(days)} -print -delete 2>/dev/null | wc -l`,
  );
  const pruned = Number(r.stdout.trim()) || 0;
  return { pruned };
}

/** How a session reads in the picker. */
export function describeSession(s) {
  const bits = [];
  if (s.live) bits.push("running now");
  if (s.turns) bits.push(`${s.turns} message${s.turns === 1 ? "" : "s"}`);
  return bits.join(" · ");
}
