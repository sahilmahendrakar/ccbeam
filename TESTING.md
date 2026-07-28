# ccteleport — test brief

You are testing `ccteleport`, a tool that moves a Claude Code session between
machines. It launches the real `claude`, and on `/teleport` ships the session
transcript and uncommitted git work over SSH and resumes the **same session** on
another machine attached to the same terminal.

Everything in this brief has been verified on a Linux box already, **except the
two things in Phase 4 and Phase 5** — those are the point of this exercise.
Report what actually happened, including anything that looked wrong but passed.

## Before you start — read this

- **Never run the carry tests in a repository whose uncommitted work matters.**
  `/teleport` moves your dirty diff to another machine and `/back` moves it home,
  replacing the working tree in the process. Use throwaway repos created by the
  steps below.
- `install-shell` edits `~/.bashrc` / `~/.zshrc` / `config.fish`. It backs the
  file up first and `uninstall-shell` restores it byte-for-byte, but prefer
  `--rc /tmp/somefile` when you only want to check behaviour.
- Don't commit anything to the repo or push. Report findings only.

## Setup

```bash
git clone https://github.com/sahilmahendrakar/ccteleport   # private repo
cd ccteleport
node --version        # must be >= 18
```

It is not on npm. Either run it directly as `node /path/to/ccteleport/bin/ccteleport.mjs`
or `npm link` to get a real `ccteleport` on PATH. Use one form consistently and
say which you used.

## What you need

- **Machine A** — where you are. Claude Code installed and signed in.
- **Machine B** — any machine you can `ssh` into, with Claude Code **signed in
  there**, plus `node` 18+ and `git`.

To check B: `ccteleport doctor <host>` should end in `ready`.

**If B is a server you ssh into:** Claude Code's config location comes from
`CLAUDE_CONFIG_DIR`, which is usually **not set for non-interactive ssh
sessions** even if your shell profile sets it. So B may be authenticated under a
custom config dir interactively but unauthenticated under `$HOME/.claude`, which
is what ccteleport will use. Verify with:

```bash
ssh <host> 'cd /tmp && claude -p "say READY"'
```

If that fails to authenticate, run `ssh -t <host> "claude auth login"` first.
This is the single most likely reason Phase 4 fails, and it is a real product
finding worth reporting if the error message is unhelpful.

---

## Phase 0 — smoke

```bash
node bin/ccteleport.mjs --help
node bin/ccteleport.mjs doctor
node bin/ccteleport.mjs machines
npm test
```

Expected: help renders; `machines` lists `local` plus hosts from your
`~/.ssh/config`; **12/12** unit tests pass.

## Phase 1 — a conversation moves between folders (no second machine)

```bash
CCT_HOST=nonexistent node test/e2e.mjs A
```

Expected: **2/2 passed**. This proves a real Claude Code conversation survives a
move and recalls its context. If this fails, stop and report — nothing else will
work.

## Phase 2 — SSH machinery

```bash
CCT_HOST=<your-machine-B> node test/e2e.mjs
```

Expected: **5/5 passed**. This covers shipping the transcript, carrying
uncommitted work out, and bringing both back.

## Phase 3 — shell integration

```bash
node bin/ccteleport.mjs install-shell --rc /tmp/testrc --shell zsh
cat /tmp/testrc
node bin/ccteleport.mjs install-shell --rc /tmp/testrc --shell zsh   # idempotent
node bin/ccteleport.mjs uninstall-shell --rc /tmp/testrc --shell zsh
cat /tmp/testrc   # must be byte-identical to before
```

Then check it works for real, against your actual shell:

```bash
node bin/ccteleport.mjs install-shell
exec $SHELL
type claude              # should say: claude is a function
command claude --version # should still reach the real binary
ccteleport uninstall-shell
```

---

## Phase 4 — THE UNVERIFIED ONE: a real interactive teleport

**This is the main event.** Nothing has ever run a model call on a remote
machine through this tool.

Set up two throwaway repos at the same commit:

```bash
# on A
mkdir -p /tmp/cct-demo && cd /tmp/cct-demo
git init -q && echo "original" > file.txt
git add -A && git -c user.email=t@t -c user.name=t commit -qm base
git log -1 --format=%H     # note the commit

# put a clone on B at the same commit, e.g.
ssh <host> 'mkdir -p /tmp/cct-demo'
git push <host>:/tmp/cct-demo-origin HEAD 2>/dev/null || \
  ssh <host> 'cd /tmp && git clone -q /path/or/copy cct-demo'
```

(Any method is fine — the requirement is only that B's checkout is on the **same
commit** as A's.)

Then, on A, with an uncommitted change:

```bash
cd /tmp/cct-demo
echo "edited on machine A" > file.txt
node /path/to/ccteleport/bin/ccteleport.mjs
```

In the session:

1. Say: `Remember the codeword PLATYPUS.`
2. Run: `/teleport <host>:/tmp/cct-demo`
3. **Watch what happens to your terminal.** Record it.
4. Once you're on B, ask: `What was the codeword? And what does file.txt contain?`
5. Have it create a file: `Write a file called from-B.txt containing "made on B".`
6. Run: `/back`
7. Ask: `What was the codeword?`
8. Exit.

**Report specifically:**

- Did `/teleport` work as typed, or did you need `/ccteleport:teleport`? *(The
  short form is unverified — this is a known open question.)*
- Did the remote session **visually redraw the earlier conversation**, or did you
  land at an empty prompt that merely remembered things?
- Did it recall `PLATYPUS` on B? Did it see `edited on machine A` in `file.txt`?
- After `/back`: is `from-B.txt` present on A? Does `file.txt` still say
  `edited on machine A`? Did it still recall `PLATYPUS`?
- How long did each transition take? Was there any confusing dead air?
- Was it ever unclear which machine you were on?

Finally, confirm nothing was orphaned on B:

```bash
ssh <host> 'ls ~/.ccteleport'
```

## Phase 5 — THE OTHER UNVERIFIED ONE: the interactive picker

Run `ccteleport`, then `/teleport` **with no arguments**. You should get a
machine list, then a folder list.

If you can't drive a TUI directly, use tmux:

```bash
tmux new-session -d -s cct -x 200 -y 50 'node /path/to/ccteleport/bin/ccteleport.mjs'
sleep 5
tmux send-keys -t cct '/teleport' Enter
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

1. **Unreachable machine:** `/teleport definitely-not-a-host:/tmp`
2. **Commit mismatch:** on B, `cd /tmp/cct-demo && git commit --allow-empty -qm drift`,
   then teleport there from A with a dirty file. It must **refuse to carry** and
   say which commit each side is on.
3. **Dirty destination:** make an uncommitted edit on B, then teleport there with
   a dirty file on A. It must refuse rather than overwrite.
4. **Directory that doesn't exist on B:** `/teleport <host>:/tmp/nope-not-here`

After each, verify **nothing was lost on either side**.

---

## Report back

For each phase: pass / fail / didn't run, with the actual output. Then:

1. **Anything that lost or corrupted work** — highest priority by far.
2. **Whether `/teleport` resolves without the `ccteleport:` prefix.**
3. **Whether the remote session visually redraws the conversation.**
4. Anything confusing, slow, or ugly in the UX — especially moments where you
   couldn't tell which machine you were on.
5. Exact error text for anything that failed, plus `ccteleport doctor <host>`.

Don't fix anything. Report it.
