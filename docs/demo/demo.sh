#!/usr/bin/env bash
#
# A RE-ENACTMENT, not a capture.
#
# This script prints ccbeam's output — the picker, the notes, the banner — with
# realistic pauses, so `docs/demo/ccbeam.gif` can be re-recorded deterministically
# without two signed-in machines and a live model turn. Every ccbeam string,
# colour and glyph below is copied from the real implementation:
#
#   picker frame + footer   src/picker.mjs
#   device / folder rows    bin/ccbeam.mjs  (resolveDestination)
#   note / banner           src/ui.mjs
#
# The Claude Code welcome box is not drawn here at all: header.ans is a recording
# of the real one, made by capture-header.sh. The input box and status line under
# it are still an approximation of somebody else's UI, and will drift from it.
#
# Keep it under ~20s. The payoff is the last beat — coming home with the work —
# and nobody watches a README GIF for forty seconds to reach it.
#
# If you change any of the above, change this too, then: vhs docs/demo/demo.tape
#
set -u

E=$'\033'
dim()  { printf '%s[2m%s%s[0m' "$E" "$1" "$E"; }
bold() { printf '%s[1m%s%s[0m' "$E" "$1" "$E"; }
inv()  { printf '%s[7m%s%s[0m' "$E" "$1" "$E"; }

# Claude Code's orange.
O="$E[38;2;217;119;87m"
R="$E[0m"

W=70 # inner width of the boxes

# Strip colours before measuring: pad on the raw string and the escapes count as
# characters. picker.mjs does the same thing for the same reason.
strip() { printf '%s' "$1" | sed "s/$E\[[0-9;]*[a-zA-Z]//g"; }
vlen()  { local b; b=$(strip "$1"); printf '%s' "${#b}"; }

rule() { local n=$1 out='' i; for ((i = 0; i < n; i++)); do out+='─'; done; printf '%s' "$out"; }

# ── Claude Code chrome ──────────────────────────────────────────────────────
# The welcome box is not drawn here, it is *replayed*: header.ans holds the real
# bytes `claude` printed, captured by capture-header.sh. Hand-drawing it never
# quite matched — this cannot fail to. The capture also contains whatever else
# was on screen at the time (release notes, promos), so everything below the box
# is cleared once it has painted.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEADER_ROWS=12

cc_header() {
  cat "$HERE/header.ans"
  printf '%s[%d;1H%s[J' "$E" "$((HEADER_ROWS + 1))" "$E"
}

cc_prompt() { # draw the input box, then type $1 inside it
  local s=$1 i
  printf '\n%s╭%s╮%s\n' "$(dim '')" "$(rule $W)" ""
  printf '%s│%s %s %*s%s│%s\n' "" "" "$(dim '›')" "$((W - 3))" "" "" ""
  printf '%s╰%s╯%s\n' "" "$(rule $W)" ""
  printf '  %s\n' "$(dim 'manual mode on · ? for shortcuts')"

  # back up into the box and type on the line, leaving the right border alone
  printf '%s[3A\r%s[4C' "$E" "$E"
  for ((i = 0; i < ${#s}; i++)); do
    printf '%s' "${s:i:1}"
    sleep 0.022
  done
  sleep 0.45
  printf '%s[3B\r' "$E"
}

cc_reply() { printf '\n%s %s\n' "$O⏺$R" "$1"; }

clear_screen() { printf '%s[2J%s[H' "$E" "$E"; }

# ── ccbeam's own output ─────────────────────────────────────────────────────
# src/ui.mjs — note()
note() { printf '%s %s\n' "$(dim '  ·')" "$1"; }

# src/ui.mjs — banner(): cyan(bold(" <mark> <device>:<dir>")) + dim hint
banner() {
  local mark=$1 where=$2 hint=${3:-}
  printf '\n%s[1;36m %s %s%s[0m' "$E" "$mark" "$where" "$E"
  [ -n "$hint" ] && printf '%s' "$(dim "  ·  $hint")"
  printf '\n\n'
}

# Repaint in place, the way src/picker.mjs does: cursor up N, clear down.
repaint() { printf '%s[%dA\r%s[J' "$E" "$1" "$E"; }

pad_to() {
  local s=$1 w=$2 n
  n=$((w - $(vlen "$s")))
  if [ "$n" -gt 0 ]; then printf '%s%*s' "$s" "$n" ""; else printf '%s' "$s"; fi
}

PICKER_FOOTER='↑↓ select · ⏎ confirm · type to filter · esc cancel'

# One picker frame. $1 = title, $2 = selected index, rest = row texts.
frame() {
  local title=$1 sel=$2 i=0 row
  shift 2
  printf '%s\n' "$(bold "  $title")"
  for row in "$@"; do
    if [ "$i" -eq "$sel" ]; then
      printf '%s\n' "$(inv " $(pad_to "$row" 66) ")"
    else
      printf '  %s\n' "$row"
    fi
    i=$((i + 1))
  done
  printf '%s\n' "$(dim "$PICKER_FOOTER")"
}

# bin/ccbeam.mjs: `${mark} ${name.padEnd(18)} ${dim(state || relTime)}`
dev_row() { printf '%s %-18s %s\n' "$1" "$2" "$(dim "$3")"; }

# bin/ccbeam.mjs: `${tilde(dir).padEnd(42)} ${dim(branch + dirty)}`
dir_row() { printf '%-42s %s\n' "$1" "$(dim "$2")"; }

# ── the demo ────────────────────────────────────────────────────────────────
clear_screen
# picker.mjs hides the cursor while it owns the screen; so does this.
printf '%s[?25l' "$E"
trap 'printf "%s[?25h" "$E"' EXIT
sleep 0.5

# 1 — a session on the laptop
cc_header
sleep 0.9
cc_prompt 'the tests only pass on my machine. /ccbeam:up'
cc_reply 'Heading over.'
sleep 1.0

# 2 — the local claude has exited and the supervisor owns the terminal. No
# clear: the picker really does appear below the session you were just in, and
# leaving it there keeps the frame full.
printf '\n'
sleep 0.3

mapfile -t DEVICES < <(
  dev_row '⌂' local     'you are here'
  dev_row ' ' gpu-box   '2h ago'
  dev_row ' ' mac-mini  'yesterday'
  dev_row '☁' cloud     'paused'
)

# preselect skips the device you are already on
frame 'beam to' 1 "${DEVICES[@]}"
sleep 1.0
repaint 6
frame 'beam to' 2 "${DEVICES[@]}"
sleep 0.45
repaint 6
frame 'beam to' 1 "${DEVICES[@]}"
sleep 0.6
repaint 6

mapfile -t FOLDERS < <(
  dir_row '~/dev/api'      'main ·3 dirty'
  dir_row '~/src/trainer'  'cuda-12'
  dir_row '~/dev/scratch'  'main'
)

# the folder you used last is preselected — so this is ⏎ ⏎
frame 'gpu-box — folder' 0 "${FOLDERS[@]}"
sleep 1.1
repaint 5

note 'beaming to gpu-box'
sleep 1.0
note 'carried 3 changed file(s)'
sleep 0.5
banner '⚡' 'gpu-box:~/dev/api' '/ccbeam:home to return'
sleep 1.0

# 3 — the same conversation, now running over there
clear_screen
sleep 0.3
cc_header
sleep 0.9
cc_prompt 'npm test'
printf '\n  %s\n' "$(dim '42 passing (4.1s)')"
sleep 1.1
cc_prompt '/ccbeam:home'
cc_reply 'Heading home.'
sleep 0.9

# 4 — and back, with the work
printf '\n'
sleep 0.3
note 'returning to ~/dev/api'
sleep 0.9
note 'brought back 2 changed file(s)'
sleep 0.5
banner '⌂' 'local:~/dev/api'
sleep 1.1
# claude relaunching here redraws the screen, so this clear is the real thing
clear_screen
cc_header
sleep 2.5
