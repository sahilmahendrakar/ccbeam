# ccbeam — test brief

You are testing `ccbeam`, a tool that moves a Claude Code session between
machines. It launches the real `claude`, and on `/ccbeam:up` ships the session
transcript and uncommitted git work over SSH and resumes the **same session** on
another machine attached to the same terminal.

Everything in this brief has been verified on a Linux box already, **except the
two things in Phase 4 and Phase 5** — those are the point of this exercise.
Report what actually happened, including anything that looked wrong but passed.

## Before you start — read this

- **Never run the carry tests in a repository whose uncommitted work matters.**
  `/ccbeam:up` moves your dirty diff to another machine and `/ccbeam:home` moves it home,
  replacing the working tree in the process. Use throwaway repos created by the
  steps below.
- `install-shell` edits `~/.bashrc` / `~/.zshrc` / `config.fish`. It backs the
  file up first and `uninstall-shell` restores it byte-for-byte, but prefer
  `--rc /tmp/somefile` when you only want to check behaviour.
- Don't commit anything to the repo or push. Report findings only.

## Setup

```bash
git clone https://github.com/sahilmahendrakar/ccbeam   # private repo
cd ccbeam
node --version        # must be >= 18
```

It is not on npm. Either run it directly as `node /path/to/ccbeam/bin/ccbeam.mjs`
or `npm link` to get a real `ccbeam` on PATH. Use one form consistently and
say which you used.

## What you need

- **Machine A** — where you are. Claude Code installed and signed in.
- **Machine B** — any machine you can `ssh` into, with Claude Code **signed in
  there**, plus `node` 18+ and `git`.

To check B: `ccbeam doctor <host>` should end in `ready`.

**If B is a server you ssh into:** Claude Code's config location comes from
`CLAUDE_CONFIG_DIR`, which is usually **not set for non-interactive ssh
sessions** even if your shell profile sets it. So B may be authenticated under a
custom config dir interactively but unauthenticated under `$HOME/.claude`, which
is what ccbeam will use. Verify with:

```bash
ssh <host> 'cd /tmp && claude -p "say READY"'
```

If that fails to authenticate, run `ssh -t <host> "claude auth login"` first.
This is the single most likely reason Phase 4 fails, and it is a real product
finding worth reporting if the error message is unhelpful.

---

## Phase 0 — smoke

```bash
node bin/ccbeam.mjs --help
node bin/ccbeam.mjs doctor
node bin/ccbeam.mjs devices
npm test
```

Expected: help renders; `devices` lists `local` plus hosts from your
`~/.ssh/config`; **24/24** unit tests pass.

## Phase 1 — a conversation moves between folders (no second machine)

```bash
CCBEAM_HOST=nonexistent node test/e2e.mjs A
```

Expected: **3/3 passed**. This proves a real Claude Code conversation survives a
move and recalls its context. If this fails, stop and report — nothing else will
work.

## Phase 2 — SSH machinery

```bash
CCBEAM_HOST=<your-machine-B> node test/e2e.mjs
```

Expected: **8/8 passed** (3 local + 5 ssh). This covers shipping the transcript, carrying
uncommitted work out, and bringing both back.

## Phase 3 — shell integration

```bash
node bin/ccbeam.mjs install-shell --rc /tmp/testrc --shell zsh
cat /tmp/testrc
node bin/ccbeam.mjs install-shell --rc /tmp/testrc --shell zsh   # idempotent
node bin/ccbeam.mjs uninstall-shell --rc /tmp/testrc --shell zsh
cat /tmp/testrc   # must be byte-identical to before
```

Then check it works for real, against your actual shell:

```bash
node bin/ccbeam.mjs install-shell
exec $SHELL
type claude              # should say: claude is a function
command claude --version # should still reach the real binary
ccbeam uninstall-shell
```

---

## Phase 4 — THE UNVERIFIED ONE: a real interactive beam

**This is the main event.** Nothing has ever run a model call on a remote
machine through this tool.

Set up two throwaway repos at the same commit:

```bash
# on A
mkdir -p /tmp/ccbeam-demo && cd /tmp/ccbeam-demo
git init -q && echo "original" > file.txt
git add -A && git -c user.email=t@t -c user.name=t commit -qm base
git log -1 --format=%H     # note the commit

# put a clone on B at the same commit, e.g.
ssh <host> 'mkdir -p /tmp/ccbeam-demo'
git push <host>:/tmp/ccbeam-demo-origin HEAD 2>/dev/null || \
  ssh <host> 'cd /tmp && git clone -q /path/or/copy ccbeam-demo'
```

(Any method is fine — the requirement is only that B's checkout is on the **same
commit** as A's.)

Then, on A, with an uncommitted change:

```bash
cd /tmp/ccbeam-demo
echo "edited on machine A" > file.txt
node /path/to/ccbeam/bin/ccbeam.mjs
```

In the session:

1. Say: `Remember the codeword PLATYPUS.`
2. Run: `/ccbeam:up <host>:/tmp/ccbeam-demo`
3. **Watch what happens to your terminal.** Record it.
4. Once you're on B, ask: `What was the codeword? And what does file.txt contain?`
5. Have it create a file: `Write a file called from-B.txt containing "made on B".`
6. Run: `/ccbeam:home`
7. Ask: `What was the codeword?`
8. Exit.

**Report specifically:**

- Do both `/ccbeam:up` and `/ccbeam:home` show up in the slash menu, and does
  the unambiguous short form (`/up`, `/home`) resolve interactively? *(Only the
  namespaced form is verified — print mode requires it.)*
- Did the remote session **visually redraw the earlier conversation**, or did you
  land at an empty prompt that merely remembered things?
- Did it recall `PLATYPUS` on B? Did it see `edited on machine A` in `file.txt`?
- After `/ccbeam:home`: is `from-B.txt` present on A? Does `file.txt` still say
  `edited on machine A`? Did it still recall `PLATYPUS`?
- How long did each transition take? Was there any confusing dead air?
- Was it ever unclear which machine you were on?

Finally, confirm nothing was orphaned on B:

```bash
ssh <host> 'ls ~/.ccbeam'
```

## Phase 5 — THE OTHER UNVERIFIED ONE: the interactive picker

Run `ccbeam`, then `/ccbeam:up` **with no arguments**. You should get a
machine list, then a folder list.

If you can't drive a TUI directly, use tmux:

```bash
tmux new-session -d -s cct -x 200 -y 50 'node /path/to/ccbeam/bin/ccbeam.mjs'
sleep 5
tmux send-keys -t cct '/ccbeam:up' Enter
sleep 8
tmux capture-pane -t cct -p        # screenshot the picker
tmux send-keys -t cct Down
tmux capture-pane -t cct -p        # did the highlight move?
tmux send-keys -t cct Enter
sleep 5
tmux capture-pane -t cct -p        # folder list?
tmux kill-session -t cct
```

**Report:** Does the machine list appear, and is `local` in it? Do arrow keys
move the selection? Does typing filter? Does Esc cancel cleanly and leave the
terminal usable? Does the folder list show branch and dirty-file counts? Is the
last-used folder pre-selected? **Paste the captured panes.**

## Phase 6 — failure modes

These should all fail *gracefully*, with a plain-language explanation and no
data loss. Report the exact wording — clarity is the feature here.

1. **Unreachable machine:** `/ccbeam:up definitely-not-a-host:/tmp`
2. **Commit mismatch:** on B, `cd /tmp/ccbeam-demo && git commit --allow-empty -qm drift`,
   then beam there from A with a dirty file. It must **refuse to carry** and
   say which commit each side is on.
3. **Dirty destination:** make an uncommitted edit on B, then beam there with
   a dirty file on A. It must refuse rather than overwrite.
4. **Directory that doesn't exist on B:** `/ccbeam:up <host>:/tmp/nope-not-here`

After each, verify **nothing was lost on either side**.

---

## Phase 7 — the cloud box

This has now been run for real against E2B. What's verified, and what isn't:

**Verified end to end** (`npm run test:e2e C`, with a box set up):
sandbox create (~350ms), provisioning (7s: node 20 and git are already in E2B's
`base` image, Claude Code installs into `~/.npm-global`), probe, directory
transfer both ways preserving modes/symlinks/binary content, seeding a fresh
repo onto the same commit, pause (~360ms) and resume (~500ms) with the
filesystem intact, and a full beamOut/beamBack round trip.

Two bugs this found, both of which only appear on a *second* run:
- E2B's file API cannot overwrite an existing file in `/tmp` (sticky bit), so
  the first beam worked and every one after it failed. Everything ccbeam writes
  into the box now lives under `~/.ccbeam/`.
- `sandbox.betaPause()` reaches the API with no authorization header on e2b
  2.2.1 and fails — which would have left boxes running. `release()` now uses
  the static `Sandbox.betaPause(id, {apiKey})` and reads the state back to
  confirm.

Session resume and cleanup are covered too (C4): listing conversations in the
box with their opening line, adopting one without shipping a transcript or
touching the current repo, refusing a session id that isn't there, and deleting
every copy of a conversation while keeping the folder it worked in.

Detach/reattach was measured directly: work continues after disconnect (a PTY
kept ticking 5 → 10 while nothing was attached), the process survives with the
same pid, and pause freezes a running turn and resumes it intact. E2B's
`commands.connect()` has no `onPty` option, so there is no visual replay of a
live TUI — which does not matter, because reattaching is `claude --resume` and
the transcript is the session.

**The SDK is pinned exactly** (`src/cloud/sdk.mjs`), because it isn't a
dependency and so has no lockfile in front of it. Everything above was verified
on e2b 2.2.1; the pin is now 2.36.1, where `Sandbox.betaCreate` is gone and
pause-on-timeout moved from `autoPause: true` to `lifecycle: {onTimeout:
'pause'}`. That path is covered by unit tests against fakes but **has not been
re-run against real E2B** — phase 7's C-suite is the check that matters. Note
the cloud path now needs Node 20.18.1+ (not 21.x).

**Still unverified: a real interactive session in the box.** The tests stop at
`claude --version` because the box has to be signed in first, and signing in
needs a terminal. So the one thing left to check by hand:

1. `ccbeam cloud` and complete the sign-in.
2. From a git repo: `ccbeam`, make an edit, `/ccbeam:up cloud`.
3. Does the TUI render properly over the relay — colours, redraw, no stray
   shell prompt? Does Ctrl-C interrupt the turn rather than kill the session?
   Does resizing the window reflow it?
4. `/ccbeam:home`. Did the work come back? Did it print `cloud paused`?
5. Check <https://e2b.dev/dashboard>: **paused**, not running.
6. Then `/ccbeam:up cloud resume` — does the conversation you just had appear in the
   list, with its opening line? Does picking it redraw it? Does Ctrl-D offer to
   delete, and does `esc` still pause the box on the way out?

---

## Report back

For each phase: pass / fail / didn't run, with the actual output. Then:

1. **Anything that lost or corrupted work** — highest priority by far.
2. **Whether `/ccbeam:up` resolves without the `ccbeam:` prefix.**
3. **Whether the remote session visually redraws the conversation.**
4. Anything confusing, slow, or ugly in the UX — especially moments where you
   couldn't tell which machine you were on.
5. Exact error text for anything that failed, plus `ccbeam doctor <host>`.

Don't fix anything. Report it.
