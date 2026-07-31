#!/usr/bin/env bash
#
# Re-capture docs/demo/header.ans — the real Claude Code welcome box.
#
# The demo used to redraw that box by hand, which never quite looked right. It
# doesn't have to: `claude` will print it for us, so this records the actual
# bytes and the demo replays them. Refresh it when Claude Code's header changes.
#
#   bash docs/demo/capture-header.sh
#
# Two things have to line up or the box will wrap in the recording:
#
#   * the width must match the vhs terminal — 93 cols at the tape's current
#     920x620 / 16px (check with `stty size` inside a throwaway tape)
#   * TERM/COLORTERM must advertise truecolour, or Claude Code falls back to a
#     pale 16-colour theme and the mascot comes out grey
#
# The capture runs in a throwaway ~/dev/api so the box shows a path that fits
# the demo's story. It is removed again below.
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
OUT="docs/demo/header.ans"
DIR="$HOME/dev/api"
COLS=93
ROWS=27

cleanup() { rm -rf "$DIR"; }
trap cleanup EXIT

mkdir -p "$DIR"
git -C "$DIR" init -q 2>/dev/null || true

raw=$(mktemp)
TERM=xterm-256color COLORTERM=truecolor timeout 12 script -qec \
  "stty cols $COLS rows $ROWS; cd '$DIR' && TERM=xterm-256color COLORTERM=truecolor claude" \
  /dev/null > "$raw" 2>&1 </dev/null || true

# Strip what only makes sense to a live terminal: the alternate screen (which
# would swallow the rest of the demo), mouse and paste modes, the window title,
# and the terminal-capability queries Claude Code sends on startup. Colour and
# cursor positioning are kept — they are what draws the box.
perl -0777 -pe '
  s/\e\[\?(?:1049|1000|1002|1003|1006|2004|1004|2031|25)[hl]//g;
  s/\e\][^\a\e]*(?:\a|\e\\)//g;
  s/\e\[>?\d*[cq]//g;
  s/\e[78]//g;
  s/\e\[r//g;
' "$raw" > "$OUT"
rm -f "$raw"

printf 'wrote %s (%s bytes)\n' "$OUT" "$(wc -c < "$OUT")"
printf 'the capture holds whatever else was on screen (release notes, promos);\n'
printf 'demo.sh clears everything below the box, so only the header shows.\n'
